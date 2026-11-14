#!/usr/bin/env python3
"""
install_service.py — Installs the MCP bridge so it starts BY ITSELF when you log in.

One-time setup.

Afterwards the extension is all you need: the bridge will already be listening in the background.

Other options:
    python server/install_service.py --uninstall   # removes the automatic startup
    python server/install_service.py --dry-run     # shows what it would do without touching anything

The MCP servers that are exposed are the entries registered in `server/servers.json` — the file
ships with the terminal server already registered. Add more entries there; the bridge reloads it
on save.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRIDGE = HERE / "mcp_ws_bridge.py"
CONFIG = HERE / "servers.json"
LOG = HERE / "bridge.log"
LAUNCHER = HERE / "start_bridge_loop.pyw"
NAME = "LongArm"


def default_config() -> dict:
    """An empty configuration: the servers under `mcp/` are found by the bridge by themselves, so this
    file is only for servers that live somewhere else."""
    return {"servers": []}


def ensure_config(dry: bool) -> None:
    if CONFIG.exists():
        print(f"• Using the existing configuration: {CONFIG}")
        return
    print(f"• Creating {CONFIG} (empty: register your MCP servers in it)")
    if not dry:
        CONFIG.write_text(json.dumps(default_config(), indent=2, ensure_ascii=False), encoding="utf-8")


def launcher_command(windowless: bool = False) -> list[str]:
    """Launcher command: this is what starts with Windows and keeps the bridge alive."""
    py = sys.executable
    if windowless and sys.platform == "win32":
        pyw = Path(py).with_name("pythonw.exe")
        py = str(pyw) if pyw.exists() else py
    return [py, str(LAUNCHER)]


def _ports() -> tuple[int, int]:
    """(bridge control port, launcher port) according to servers.json."""
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    except Exception:
        cfg = {}
    return int(cfg.get("control_port", 8099)), int(cfg.get("launcher_port", 8098))


def _post(port: int, path: str, timeout: float = 4) -> bool:
    """POST without an Origin header (the bridge and the launcher accept it). True if it answered."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="POST", data=b"")
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except Exception:
        return False


def start_launcher() -> None:
    """Leaves the launcher running right now: if one is already there it asks it to restart; if not, it starts one detached."""
    control, launcher = _ports()
    if _post(launcher, "/restart"):
        print("-> Launcher already active: bridge restarted.")
        return
    _post(control, "/shutdown")  # a stray bridge (without a launcher) would hold the ports
    time.sleep(1.5)
    flags = 0
    if sys.platform == "win32":
        flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    subprocess.Popen(launcher_command(windowless=True), cwd=str(HERE), creationflags=flags, close_fds=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("-> Launcher started in the background.")


def stop_launcher() -> None:
    control, launcher = _ports()
    _post(launcher, "/quit")
    _post(control, "/shutdown")

def restart_bridge() -> int:
    """Restarts the bridge: stops the previous one (or an old bridge holding the ports) and starts a new one in the background."""
    cmd = [sys.executable, str(BRIDGE), "--config", str(CONFIG), "--log-file", str(LOG), "--restart"]
    return subprocess.run(cmd).returncode


def bridge_command(windowless: bool = False) -> list[str]:
    py = sys.executable
    if windowless and sys.platform == "win32":
        pyw = Path(py).with_name("pythonw.exe")
        py = str(pyw) if pyw.exists() else py
    return [py, str(BRIDGE), "--config", str(CONFIG), "--log-file", str(LOG)]


# ───────────────────────── Windows ─────────────────────────

def windows_startup_file() -> Path:
    return Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs/Startup" / f"{NAME}.vbs"


def install_windows(dry: bool) -> None:
    cmd = " ".join(f'""{part}""' for part in launcher_command(windowless=True))
    script = f'CreateObject("Wscript.Shell").Run "{cmd}", 0, False\n'
    target = windows_startup_file()
    print(f"• Registering automatic startup: {target}")
    if dry:
        return
    target.write_text(script, encoding="utf-8")
    start_launcher()  # starts the launcher right away (or restarts it if it was running); the launcher brings the bridge up


def uninstall_windows(dry: bool) -> None:
    target = windows_startup_file()
    print(f"• Removing {target}")
    if not dry:
        target.unlink(missing_ok=True)
        stop_launcher()
        subprocess.run(["taskkill", "/F", "/FI", "WINDOWTITLE eq mcp_ws_bridge*"], capture_output=True)


# ───────────────────────── macOS ─────────────────────────

def mac_plist() -> Path:
    return Path.home() / "Library/LaunchAgents/com.longarm.plist"


def install_macos(dry: bool) -> None:
    args = "".join(f"<string>{a}</string>" for a in bridge_command())
    plist = (
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'
        "<key>Label</key><string>com.longarm</string>"
        f"<key>ProgramArguments</key><array>{args}</array>"
        "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>"
    )
    print(f"• Registering LaunchAgent: {mac_plist()}")
    if dry:
        return
    mac_plist().parent.mkdir(parents=True, exist_ok=True)
    mac_plist().write_text(plist, encoding="utf-8")
    subprocess.run(["launchctl", "unload", str(mac_plist())], capture_output=True)
    subprocess.run(["launchctl", "load", "-w", str(mac_plist())], check=True)


def uninstall_macos(dry: bool) -> None:
    print(f"• Removing {mac_plist()}")
    if not dry:
        subprocess.run(["launchctl", "unload", str(mac_plist())], capture_output=True)
        mac_plist().unlink(missing_ok=True)


# ───────────────────────── Linux (systemd --user) ─────────────────────────

def linux_unit() -> Path:
    return Path.home() / ".config/systemd/user/longarm.service"


def install_linux(dry: bool) -> None:
    exec_start = " ".join(f'"{a}"' for a in bridge_command())
    unit = (
        "[Unit]\nDescription=LongArm\n\n"
        f"[Service]\nExecStart={exec_start}\nRestart=always\nRestartSec=3\n\n"
        "[Install]\nWantedBy=default.target\n"
    )
    print(f"• Registering user systemd service: {linux_unit()}")
    if dry:
        return
    linux_unit().parent.mkdir(parents=True, exist_ok=True)
    linux_unit().write_text(unit, encoding="utf-8")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", "longarm.service"], check=True)


def uninstall_linux(dry: bool) -> None:
    print(f"• Removing {linux_unit()}")
    if not dry:
        subprocess.run(["systemctl", "--user", "disable", "--now", "longarm.service"], capture_output=True)
        linux_unit().unlink(missing_ok=True)


# ───────────────────────── Main ─────────────────────────

def _have_module(module: str) -> bool:
    """Can THIS interpreter import the module? (the bridge will run under this very interpreter)"""
    return subprocess.run([sys.executable, "-c", f"import {module}"], capture_output=True).returncode == 0


def ensure_websockets(dry: bool) -> bool:
    """Makes sure `websockets` is importable by the interpreter that will run the bridge.

    Debian/Ubuntu ship a Python without pip and block system-wide pip installs (PEP 668), so this
    tries, in order: already installed → pip → pip --user → pip --break-system-packages — and when
    pip itself is missing, ensurepip first. If none of it can work, it prints the exact remedy and
    returns False (the old behaviour was a bare traceback).
    """
    if _have_module("websockets"):
        print("• websockets is already installed.")
        return True
    if dry:
        print("• (dry-run) websockets would be installed here")
        return True

    install_args = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                    "-q", "-r", str(HERE / "requirements.txt")]
    attempts = [install_args, [*install_args, "--user"], [*install_args, "--break-system-packages"]]

    if not _have_module("pip"):
        print("• pip is missing: trying ensurepip…", flush=True)
        if subprocess.run([sys.executable, "-m", "ensurepip", "--upgrade"]).returncode != 0:
            print(
                "\n  ✘ The bridge needs the `websockets` package and this Python has no working pip.\n"
                "  Install it with your package manager (pick one) and run this installer again:\n\n"
                "      sudo apt install python3-websockets     # Ubuntu/Debian: simplest\n"
                "      sudo apt install python3-pip            # or: pip itself, then this installer\n"
            )
            return False

    last = ""
    for attempt in attempts:
        res = subprocess.run(attempt, capture_output=True, text=True)
        if res.returncode == 0:
            print("✔ websockets installed.")
            return True
        last = (res.stderr or res.stdout or "").strip()

    print(
        "\n  ✘ The `websockets` package could not be installed automatically.\n"
        "  Install it with your package manager and run this installer again:\n\n"
        "      sudo apt install python3-websockets\n"
    )
    if last:
        print(f"  Last error: {last.splitlines()[-1] if last.splitlines() else last}")
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Installs the MCP bridge as an automatic-startup service.")
    parser.add_argument("--uninstall", action="store_true", help="Removes the automatic startup")
    parser.add_argument("--dry-run", action="store_true", help="Shows the steps without running them")
    parser.add_argument("--restart", action="store_true", help="Restarts the bridge now (stops the previous one even if it is holding the ports)")
    args = parser.parse_args()

    if args.restart:
        return restart_bridge()

    system = {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux")
    actions = {
        "windows": (install_windows, uninstall_windows),
        "macos": (install_macos, uninstall_macos),
        "linux": (install_linux, uninstall_linux),
    }[system]

    if args.uninstall:
        actions[1](args.dry_run)
        print("✔ Automatic startup removed.")
        return 0

    if not ensure_websockets(args.dry_run):
        return 1
    ensure_config(args.dry_run)
    actions[0](args.dry_run)
    print("\n✔ Done. The bridge runs in the background and will start with your session on its own.")
    print(f"  Logs: {LOG}")
    print("  Now open the extension popup: it should show the servers in green.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
