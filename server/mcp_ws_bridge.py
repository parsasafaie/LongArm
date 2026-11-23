#!/usr/bin/env python3
"""
mcp_ws_bridge.py - WebSocket <-> MCP server (stdio) bridge.

Local MCP servers speak JSON-RPC over stdin/stdout.
The browser can only speak WebSocket. This script launches each MCP server registered in the
registry (`server/servers.json`) as a child process and forwards JSON-RPC messages in both
directions.

Quick start
-----------
    python mcp_ws_bridge.py --config servers.json        # the registry (recommended)
    python mcp_ws_bridge.py --port 8080 --name my-server -- python my_server.py   # one server, ad hoc

The registry
------------
Every MCP server is ONE entry in `server/servers.json`:

    { "servers": [
        { "name": "terminal",                            # what the AI calls it in a tool call
          "server_path": "mcp/terminal/mcp_server.py",   # the MCP server script (run with this Python)
          "guide_path": "mcp/terminal/guide.txt",        # what the AI is told about it (optional)
          "port": 8875 } ] }                             # its local WebSocket port

Relative paths are resolved against the folder `servers.json` sits in. Saving the file reloads the
bridge (nothing else to do); the control port (`http://127.0.0.1:8099`) publishes the list for the
extension.

Control port / security
-----------------------
* Control port http://127.0.0.1:8099 (`/health`, `/servers`, `/reload`, `/restart`, `/shutdown`,
  `/open-config`). The extension uses it to DETECT the registered servers by itself.
* Hot reload: saving servers.json starts/stops/restarts only the servers that changed.
* If a bridge is already running, `--config` reloads it instead of failing with "port busy".
* `--restart` restarts the bridge (stops the previous one gracefully and, if needed, frees the ports
  held by an old bridge); `--stop`, `--status` and `--reload` complete the control from the terminal.
* A port held by another program no longer takes the bridge down: that server ends up in error and the
  rest keeps going.

Security
--------
* Only listens on 127.0.0.1 by default.
* Rejects connections whose `Origin` is a web page (for example https://chatgpt.com) and any extension
  OTHER than the id pinned by manifest.json `key` (or `allowed_extension_ids` / `WMB_EXTENSION_IDS`).
  Clients without an Origin (local CLI) are accepted: they already have the user's OS rights.
* The control port applies the same exact-id rule; /reload and /shutdown only accept POST.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import logging.handlers
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

try:  # websockets >= 13
    from websockets.asyncio.server import serve as ws_serve
except ImportError:  # websockets 12
    from websockets import serve as ws_serve  # type: ignore[assignment]

VERSION = "0.1.0"
DEFAULT_CONTROL_PORT = 8099
log = logging.getLogger("mcp_ws_bridge")


class _HandshakeFailureHint(logging.Filter):
    """Turns a string of cryptic TLS-in-plain-port tracebacks into ONE actionable hint.

    A browser that upgrades ws:// to wss:// (HTTPS-First, HTTPS-Only with localhost upgrade, some VPN
    modes) connects to this plain-WS port with a TLS ClientHello; the library answers with a bare
    'opening handshake failed' traceback every time. After the fifth one, say what is really going on.
    """

    count = 0

    def filter(self, record) -> bool:
        if record.getMessage() == "opening handshake failed":
            self.count += 1
            if self.count == 5:
                log.warning(
                    "repeated failed WS handshakes: a client is speaking TLS to this plain-WS port. "
                    "A browser that upgrades ws:// to wss:// (HTTPS-First, HTTPS-Only with localhost "
                    "upgrade, or a VPN) cannot reach the bridge — check the browser's security settings"
                )
        return True


logging.getLogger("websockets.server").addFilter(_HandshakeFailureHint())

STDIO_LIMIT = 32 * 1024 * 1024  # maximum size of a JSON-RPC message
# The extension id is pinned by the `key` field of manifest.json, so every build of THIS project has the same
# id. Any OTHER Chrome extension used to pass the old `chrome-extension://` prefix check and could run tools.
DEFAULT_EXTENSION_ID = "ilnjjdjoklladplnidbfmcjgalkmigjn"
WIN = sys.platform == "win32"


def _clean_extension_id(value: object) -> str:
    text = str(value or "").strip().lower()
    return text if text and all("a" <= ch <= "p" for ch in text) and len(text) == 32 else ""


def _extension_ids_from_env() -> tuple[str, ...]:
    """`WMB_EXTENSION_IDS=a,b` for a custom build; otherwise the project id pinned in the manifest."""
    raw = os.environ.get("WMB_EXTENSION_IDS", "")
    ids = tuple(ext for ext in (_clean_extension_id(x) for x in raw.split(",")) if ext)
    return ids or (DEFAULT_EXTENSION_ID,)


def _origin_extension_id(origin: str | None) -> str:
    prefix = "chrome-extension://"
    if not origin or not origin.startswith(prefix):
        return ""
    return _clean_extension_id(origin[len(prefix):].split("/", 1)[0])


def _origin_allowed(origin: str | None, allowed_ids: tuple[str, ...]) -> bool:
    # No Origin = a command-line client on this machine (already has the user's OS rights).
    return origin is None or _origin_extension_id(origin) in allowed_ids


# The ids the control port accepts; `run()` replaces them with the registry's `allowed_extension_ids`.
ACTIVE_EXTENSION_IDS: tuple[str, ...] = _extension_ids_from_env()


def _apply_extension_ids(configs: list[ServerConfig]) -> None:
    global ACTIVE_EXTENSION_IDS
    if configs:
        ACTIVE_EXTENSION_IDS = configs[0].extension_ids
# start_bridge_loop.pyw sets it to 1: if the bridge exits to restart itself, the supervisor brings it back up.
SUPERVISED = os.environ.get("WMB_SUPERVISED") == "1"


@dataclass
class ServerConfig:
    """Configuration of an MCP server exposed over WebSocket."""

    name: str
    command: list[str]
    port: int = 8080
    host: str = "127.0.0.1"
    cwd: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    # Exact extension ids accepted (from servers.json `allowed_extension_ids`, `WMB_EXTENSION_IDS`, or the
    # id pinned by the manifest). A prefix is never accepted: any extension could present it.
    extension_ids: tuple[str, ...] = (DEFAULT_EXTENSION_ID,)
    # The server's guide file (from the registry entry's `guide_path`): the text the AI is given about it.
    guide_path: Path | None = None


# ----------------------------------------------------------------- utilities

def _request_parts(ws) -> tuple[str, dict]:
    """Gets (path, headers) compatible with the different versions of `websockets`."""
    request = getattr(ws, "request", None)
    if request is not None:
        return request.path, request.headers
    return ws.path, ws.request_headers  # websockets 12


async def _spawn(cfg: ServerConfig) -> asyncio.subprocess.Process:
    executable = shutil.which(cfg.command[0]) or cfg.command[0]  # resolves npx.cmd on Windows
    extra = {"creationflags": 0x08000000} if WIN else {}  # CREATE_NO_WINDOW
    if not WIN:
        # Own process group: a stop takes the whole tree down (a server that spawned helpers of its own
        # cannot outlive its pipe), and a SIGKILL of the bridge does not strand the grandchildren.
        extra["start_new_session"] = True
    return await asyncio.create_subprocess_exec(
        executable,
        *cfg.command[1:],
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cfg.cwd,
        env={**os.environ, **cfg.env},
        limit=STDIO_LIMIT,
        **extra,
    )


async def _stop(proc: asyncio.subprocess.Process) -> None:
    """Closes the child process tree gracefully (stdin -> terminate -> kill)."""
    if proc.returncode is not None:
        return
    try:
        proc.stdin.close()  # type: ignore[union-attr]
        await asyncio.wait_for(proc.wait(), 2)
        return
    except Exception:  # noqa: BLE001
        pass
    try:
        if WIN:
            # Kill the entire process tree on Windows so child CLI processes are not orphaned
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/F", "/T"],
                           capture_output=True, timeout=5, creationflags=0x08000000)
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)  # the group: the tree, not only the child
        await asyncio.wait_for(proc.wait(), 3)
    except Exception:  # noqa: BLE001
        try:
            if WIN:
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/F", "/T"],
                               capture_output=True, timeout=5, creationflags=0x08000000)
            else:
                proc.kill()
        except Exception:  # noqa: BLE001
            pass


# -------------------------------------------------------------------- pipes

async def _stdout_to_ws(proc: asyncio.subprocess.Process, ws) -> None:
    """MCP server stdout -> WebSocket (one line = one JSON-RPC message)."""
    assert proc.stdout is not None
    while True:
        try:
            line = await proc.stdout.readline()
        except (ValueError, asyncio.LimitOverrunError, asyncio.IncompleteReadError) as err:
            # One JSON-RPC line over STDIO_LIMIT: close this client instead of dying with a traceback.
            log.error("[%s] the server wrote a single line above the %d MB limit (%s); closing the connection",
                      "mcp", STDIO_LIMIT // (1024 * 1024), err)
            return
        if not line:
            return
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            continue
        try:
            json.loads(text)
        except ValueError:
            log.debug("stdout that is not JSON (ignored): %.200s", text)
            continue
        await ws.send(text)


async def _ws_to_stdin(proc: asyncio.subprocess.Process, ws, name: str = "mcp") -> None:
    """WebSocket -> MCP server stdin. Answers `ping` directly."""
    assert proc.stdin is not None
    async for raw in ws:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        if isinstance(message, dict) and message.get("method") == "notifications/cancelled":
            # MCP cancellation is advisory; a terminal command may ignore it. Each connection owns ONE child,
            # so a hard stop of that child is a real cancellation. The socket closes and the extension
            # reconnects (nothing else is in flight: the queue is serial).
            log.warning("[%s] Tool call cancelled by the client: stopping the MCP child", name)
            asyncio.create_task(_stop(proc))
            continue
        if isinstance(message, dict) and message.get("method") == "ping" and "id" in message:
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {}}))
            continue
        proc.stdin.write((json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
        await proc.stdin.drain()


async def _log_stderr(proc: asyncio.subprocess.Process, name: str) -> None:
    assert proc.stderr is not None
    while True:
        line = await proc.stderr.readline()
        if not line:
            return
        # The child's stderr is DATA, not log: it is tagged with <stderr> so a server cannot forge bridge
        # entries in bridge.log (the audit trail), and carriage returns are neutralized.
        text = line.decode("utf-8", errors="replace").rstrip("\r\n").replace("\r", "\\r")
        log.info("[%s] <stderr> %s", name, text)


# --------------------------------------------------------------- child caps

# Every WebSocket connection spawns its own MCP child process. A broken client (a reconnect loop, a bug)
# must not be able to pile up processes: over the cap the connection is refused at once, never queued.
MAX_CHILDREN_PER_SERVER = 8
_child_counts: dict[tuple[str, int], int] = {}


async def handle_client(ws, cfg: ServerConfig) -> None:
    """Each WebSocket connection gets its own MCP child process."""
    origin = _request_parts(ws)[1].get("Origin")
    if not _origin_allowed(origin, cfg.extension_ids):
        log.warning("[%s] Connection rejected: origin not allowed (%s)", cfg.name, origin)
        await ws.close(1008, "Origin not allowed")
        return

    key = (cfg.name, cfg.port)
    if _child_counts.get(key, 0) >= MAX_CHILDREN_PER_SERVER:
        log.warning("[%s] Connection refused: %d child processes already running", cfg.name, MAX_CHILDREN_PER_SERVER)
        await ws.close(1013, "Too many connections to this MCP server")
        return
    _child_counts[key] = _child_counts.get(key, 0) + 1
    try:
        await _serve_client(ws, cfg)
    finally:
        _child_counts[key] -= 1


async def _serve_client(ws, cfg: ServerConfig) -> None:
    try:
        proc = await _spawn(cfg)
    except (FileNotFoundError, PermissionError, OSError) as err:
        log.error("[%s] Could not run %s: %s", cfg.name, cfg.command, err)
        await ws.close(1011, "Could not start the MCP server")
        return

    log.info("[%s] Client connected -> pid %s", cfg.name, proc.pid)
    pipes = {
        asyncio.create_task(_stdout_to_ws(proc, ws)),
        asyncio.create_task(_ws_to_stdin(proc, ws, cfg.name)),
    }
    stderr_task = asyncio.create_task(_log_stderr(proc, cfg.name))
    try:
        await asyncio.wait(pipes, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in (*pipes, stderr_task):
            task.cancel()
        await asyncio.gather(*pipes, stderr_task, return_exceptions=True)
        await _stop(proc)
        log.info("[%s] Client disconnected", cfg.name)


# ------------------------------------------------------- ports and processes

def _port_owners(ports: list[int]) -> dict[int, tuple[int, str, str]]:
    """{port: (pid, name, command_line)} of whoever is LISTENING on those ports (best effort)."""
    owners: dict[int, tuple[int, str, str]] = {}
    ports = sorted({int(p) for p in ports if p})
    if not ports:
        return owners
    try:
        if WIN:
            plist = ",".join(str(p) for p in ports)
            script = (
                "$r=@(); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | "
                "Where-Object { @(%s) -contains $_.LocalPort } | ForEach-Object { "
                "$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.OwningProcess) -ErrorAction SilentlyContinue; "
                "$r += [pscustomobject]@{port=$_.LocalPort;pid=$_.OwningProcess;name=$p.Name;cmd=$p.CommandLine} }; "
                "if($r.Count){ $r | ConvertTo-Json -Compress }" % plist
            )
            res = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True, text=True, timeout=25, creationflags=0x08000000,
            )
            if res.stdout.strip():
                data = json.loads(res.stdout)
                for item in ([data] if isinstance(data, dict) else data):
                    owners.setdefault(int(item["port"]), (int(item["pid"]), item.get("name") or "?", item.get("cmd") or ""))
        else:
            for port in ports:
                res = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"], capture_output=True, text=True, timeout=10)
                pid = next((int(x) for x in res.stdout.split() if x.isdigit()), None)
                if pid:
                    ps = subprocess.run(["ps", "-p", str(pid), "-o", "comm=,args="], capture_output=True, text=True, timeout=10)
                    line = ps.stdout.strip()
                    owners[port] = (pid, line.split(" ", 1)[0] or "?", line)
    except Exception as err:  # noqa: BLE001
        log.debug("Could not query the port owners: %s", err)
    return owners


def _is_bridge_cmd(cmd: str) -> bool:
    return "mcp_ws_bridge" in (cmd or "")


def _kill_pid(pid: int) -> None:
    try:
        if WIN:
            subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"], capture_output=True, timeout=15, creationflags=0x08000000)
        else:
            os.kill(pid, 15)
    except Exception as err:  # noqa: BLE001
        log.debug("Could not kill %s: %s", pid, err)


def _free_old_bridges(ports: list[int], quiet: bool = False) -> list[int]:
    """Closes ONLY processes that are an mcp_ws_bridge and are holding any of the ports. Returns the pids."""
    killed = []
    me = os.getpid()
    for port, (pid, name, cmd) in sorted(_port_owners(ports).items()):
        if pid == me:
            continue
        if _is_bridge_cmd(cmd):
            if not quiet:
                print(f"  - closing previous bridge (pid {pid}) that was holding port {port}")
            _kill_pid(pid)
            killed.append(pid)
        elif not quiet:
            print(f"  ! port {port} is used by another program: {name} (pid {pid}); leaving it alone.")
    return killed


# ---------------------------------------------------------------- supervisor

class Supervisor:
    """Keeps the WebSocket listeners aligned with servers.json (starts, stops and restarts only what changed)."""

    def __init__(self) -> None:
        self.desired: dict[str, ServerConfig] = {}
        self.listeners: dict[str, object] = {}
        self.errors: dict[str, str] = {}
        self.stop_event = asyncio.Event()
        self.config_error: str | None = None   # last error reading servers.json (None = all good)
        self.restart_requested = False
        self.started_at = time.time()
        self.extension_ids: tuple[str, ...] = ACTIVE_EXTENSION_IDS
        # Serializes apply()/retry_failed(): a file save (the watcher) and a POST /reload can land at the
        # same time, and two interleaved applies would both try to _start_one the same listener — the loser
        # would record a false "port busy" that no config ever caused.
        self.lock = asyncio.Lock()

    async def _start_one(self, cfg: ServerConfig) -> None:
        for other_name, other in self.desired.items():
            if other_name != cfg.name and other_name in self.listeners and (other.host, other.port) == (cfg.host, cfg.port):
                self.errors[cfg.name] = f"port {cfg.port} duplicated in servers.json (already used by '{other_name}')"
                log.error("[%s] %s", cfg.name, self.errors[cfg.name])
                return
        try:
            server = await ws_serve(lambda ws, c=cfg: handle_client(ws, c), cfg.host, cfg.port, max_size=STDIO_LIMIT)
        except OSError as err:
            owner = (await asyncio.to_thread(_port_owners, [cfg.port])).get(cfg.port)
            who = f" by {owner[1]} (pid {owner[0]})" if owner else ""
            self.errors[cfg.name] = f"port {cfg.port} is busy{who}: {err.strerror or err}"
            log.error("[%s] %s", cfg.name, self.errors[cfg.name])
            return
        self.listeners[cfg.name] = server
        self.errors.pop(cfg.name, None)
        log.info("[%s] available at ws://%s:%d  ->  %s", cfg.name, cfg.host, cfg.port, " ".join(cfg.command))

    async def _stop_one(self, name: str) -> None:
        server = self.listeners.pop(name, None)
        if server is None:
            return
        try:
            server.close(close_connections=True)  # type: ignore[attr-defined]
        except TypeError:
            server.close()  # type: ignore[attr-defined]
        await asyncio.gather(server.wait_closed(), return_exceptions=True)  # type: ignore[attr-defined]
        log.info("[%s] stopped", name)

    async def apply(self, configs: list[ServerConfig]) -> dict[str, list[str]]:
        new = {c.name: c for c in configs}
        report: dict[str, list[str]] = {"started": [], "stopped": [], "restarted": []}
        async with self.lock:
            await self._apply_locked(new, report)
        return report

    async def _apply_locked(self, new: dict[str, ServerConfig], report: dict[str, list[str]]) -> None:
        for name in list(self.listeners):
            if name not in new:
                await self._stop_one(name)
                report["stopped"].append(name)
            elif self.desired.get(name) != new[name]:
                await self._stop_one(name)
                report["restarted"].append(name)
        for name in list(self.errors):
            if name not in new:
                self.errors.pop(name)
        self.desired = new
        for name, cfg in new.items():
            if name not in self.listeners:
                await self._start_one(cfg)
                if name in self.listeners and name not in report["restarted"]:
                    report["started"].append(name)
        return report

    async def retry_failed(self) -> None:
        async with self.lock:  # same lock as apply(): a retry must not race a concurrent reload
            for name, cfg in list(self.desired.items()):
                if name not in self.listeners and name in self.errors:
                    await self._start_one(cfg)

    async def stop_all(self) -> None:
        for name in list(self.listeners):
            await self._stop_one(name)

    def snapshot(self) -> list[dict]:
        items = []
        for name, cfg in self.desired.items():
            host = "127.0.0.1" if cfg.host in ("0.0.0.0", "::", "") else cfg.host
            items.append({
                "name": name,
                "host": cfg.host,
                "port": cfg.port,
                "url": f"ws://{host}:{cfg.port}",
                "status": "listening" if name in self.listeners else "error",
                "error": self.errors.get(name),
                "guide": guide_text(cfg),
            })
        return items


# ------------------------------------------------------------ control port

_REASONS = {200: "OK", 204: "No Content", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 500: "Error"}


async def _http_reply(writer, status: int, payload: dict | None, origin: str | None) -> None:
    body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    head = [f"HTTP/1.1 {status} {_REASONS.get(status, 'OK')}", "Content-Type: application/json; charset=utf-8",
            f"Content-Length: {len(body)}", "Connection: close", "Cache-Control: no-store"]
    if _origin_allowed(origin, ACTIVE_EXTENSION_IDS) and origin is not None:
        head += [f"Access-Control-Allow-Origin: {origin}", "Access-Control-Allow-Methods: GET, POST, OPTIONS",
                 "Access-Control-Allow-Private-Network: true", "Vary: Origin"]
    writer.write(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + body)
    await writer.drain()


_GUIDES: dict[Path, tuple[tuple[int, int], str]] = {}


def guide_text(cfg: ServerConfig) -> str | None:
    """The text of the server's guide.txt, re-read only when the file changed. None when there is none."""
    path = cfg.guide_path
    if not path:
        return None
    stamp = _mtime(path)
    hit = _GUIDES.get(path)
    if hit and hit[0] == stamp:
        return hit[1] or None
    try:
        text = path.read_text(encoding="utf-8-sig").strip()
    except OSError:
        text = ""
    _GUIDES[path] = (stamp, text)
    return text or None


def _open_in_editor(path: Path) -> tuple[bool, str]:
    """Opens a file with the system default editor (like the "Edit config" button in Claude Desktop)."""
    if os.environ.get("WMB_NO_OPEN") == "1":  # automatic tests: do not open anything
        return True, ""
    try:
        if WIN:
            try:
                os.startfile(str(path))  # type: ignore[attr-defined]  # noqa: S606
            except OSError:
                subprocess.Popen(["notepad.exe", str(path)])  # no program associated with .json
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
        return True, ""
    except Exception as err:  # noqa: BLE001
        return False, str(err)


async def _control_handler(reader, writer, sup: Supervisor, config_path: Path | None) -> None:
    origin = None
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
        lines = raw.decode("latin-1").split("\r\n")
        method, path = lines[0].split(" ")[:2]
        headers = {k.strip().lower(): v.strip() for k, v in (ln.split(":", 1) for ln in lines[1:] if ":" in ln)}
        origin = headers.get("origin")
        path = path.split("?")[0]
        host = headers.get("host", "")
        host_name = host.rsplit(":", 1)[0].strip("[]") if host else ""
        if host and host_name not in ("127.0.0.1", "localhost", "::1"):  # anti DNS-rebinding
            await _http_reply(writer, 403, {"ok": False, "error": "host not allowed"}, None)
        elif not _origin_allowed(origin, ACTIVE_EXTENSION_IDS):
            await _http_reply(writer, 403, {"ok": False, "error": "origin not allowed"}, None)
        elif method == "OPTIONS":
            await _http_reply(writer, 204, None, origin)
        elif method == "GET" and path == "/health":
            await _http_reply(writer, 200, {"ok": True, "version": VERSION, "pid": os.getpid(),
                                            "started_at": sup.started_at, "config_error": sup.config_error}, origin)
        elif method == "GET" and path == "/servers":
            await _http_reply(writer, 200, {"ok": True, "version": VERSION, "pid": os.getpid(),
                                            "config": str(config_path) if config_path else None, "config_error": sup.config_error,
                                            "started_at": sup.started_at, "supervised": SUPERVISED, "servers": sup.snapshot()}, origin)
        elif path in ("/reload", "/shutdown", "/restart", "/open-config") and method != "POST":
            await _http_reply(writer, 405, {"ok": False, "error": "use POST"}, origin)
        elif method == "POST" and path == "/reload":
            if not config_path:
                await _http_reply(writer, 400, {"ok": False, "error": "no servers.json"}, origin)
            else:
                configs, _ctl_port, error = load_all(config_path)
                if error:
                    sup.config_error = error
                    await _http_reply(writer, 500, {"ok": False, "error": f"invalid servers.json: {error}"}, origin)
                else:
                    _apply_extension_ids(configs)
                    sup.extension_ids = ACTIVE_EXTENSION_IDS
                    report = await sup.apply(configs)
                    sup.config_error = None
                    await _http_reply(writer, 200, {"ok": True, **report, "servers": sup.snapshot()}, origin)
        elif method == "POST" and path == "/shutdown":
            await _http_reply(writer, 200, {"ok": True, "bye": True}, origin)
            log.info("Shutdown requested through the control port")
            sup.stop_event.set()
        elif method == "POST" and path == "/restart":
            await _http_reply(writer, 200, {"ok": True, "restarting": True, "supervised": SUPERVISED}, origin)
            log.info("Restart requested through the control port")
            sup.restart_requested = True
            sup.stop_event.set()
        elif method == "POST" and path == "/open-config":
            if not config_path:
                await _http_reply(writer, 400, {"ok": False, "error": "the bridge was started without --config"}, origin)
            else:
                # A missing registry is created empty the first time it is asked for: entries are added here.
                config_file = Path(config_path)
                if not config_file.exists():
                    try:
                        config_file.parent.mkdir(parents=True, exist_ok=True)
                        config_file.write_text('{\n  "servers": []\n}\n', encoding="utf-8")
                        log.info("created %s (empty: register your MCP servers in it)", config_file)
                    except OSError as err:
                        await _http_reply(writer, 500, {"ok": False, "error": f"could not create {config_file.name}: {err}"}, origin)
                        return
                opened, detail = _open_in_editor(config_file)
                body = {"ok": opened, "path": str(config_path)}
                if not opened:
                    body["error"] = detail
                await _http_reply(writer, 200 if opened else 500, body, origin)
        else:
            await _http_reply(writer, 404, {"ok": False, "error": "unknown path"}, origin)
    except Exception as err:  # noqa: BLE001
        log.warning("control port request failed: %s", err)
        try:
            await _http_reply(writer, 500, {"ok": False, "error": str(err)}, origin)
        except Exception:  # noqa: BLE001 - the socket is gone: there is nothing left to answer on
            pass
    finally:
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


def ctl(port: int, method: str, path: str, timeout: float = 2.0) -> dict | None:
    """Synchronous client of the control port. None if no bridge is listening."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method, data=b"" if method == "POST" else None)
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (localhost only)
            return json.loads(res.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


# -------------------------------------------------------------------- main

def _mtime(path: Path) -> tuple[int, int]:
    """File fingerprint (date + size): detects saves even when the date does not change."""
    try:
        st = path.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return (0, 0)


async def _watch(sup: Supervisor, path: Path) -> None:
    """Reloads the registry (servers.json) when it is saved, and retries the servers that failed
    (port busy and the like)."""
    last = _mtime(path)
    ticks = 0
    while not sup.stop_event.is_set():
        try:
            await asyncio.wait_for(sup.stop_event.wait(), 2)
        except asyncio.TimeoutError:
            pass
        if sup.stop_event.is_set():
            break
        ticks += 1
        if _mtime(path) != last:
            last = _mtime(path)
            configs, _ctl_port, error = load_all(path)
            if error:
                sup.config_error = error
                log.error("invalid servers.json (keeping the previous configuration): %s", error)
            else:
                try:
                    _apply_extension_ids(configs)
                    sup.extension_ids = ACTIVE_EXTENSION_IDS
                    report = await sup.apply(configs)
                    sup.config_error = None
                    log.info("servers.json reloaded: %s", report)
                except Exception as err:  # noqa: BLE001 - the watcher must survive anything a config throws
                    sup.config_error = str(err)
                    log.error("reloading servers.json failed (keeping the previous configuration): %s", err)
        elif ticks % 5 == 0:
            await sup.retry_failed()


async def run(configs: list[ServerConfig], control_port: int = 0, config_path: Path | None = None,
              config_error: str | None = None) -> bool:
    """Runs the bridge until it is stopped. Returns True if a RESTART was requested."""
    _apply_extension_ids(configs)
    sup = Supervisor()
    sup.extension_ids = ACTIVE_EXTENSION_IDS
    sup.config_error = config_error
    await sup.apply(configs)
    control = None
    watcher = None
    if control_port:
        try:
            control = await asyncio.start_server(lambda r, w: _control_handler(r, w, sup, config_path), "127.0.0.1", control_port)
            log.info("Control at http://127.0.0.1:%d  (/health /servers /reload /shutdown)", control_port)
        except OSError as err:
            log.error("Control port %d is not available: %s (the extension will not be able to detect servers)", control_port, err)
    if config_path:
        watcher = asyncio.create_task(_watch(sup, config_path))
    try:
        await sup.stop_event.wait()
    finally:
        if watcher:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
        if control:
            control.close()
            try:
                await asyncio.wait_for(control.wait_closed(), 2)
            except Exception:  # noqa: BLE001
                pass
        await sup.stop_all()
    return sup.restart_requested


def _resolve_script_args(command: list[str], cwd: Path, base: Path) -> list[str]:
    """A relative script (for example tests/fixtures/test_mcp_server.py) is looked up in the cwd, next to servers.json and in the project root."""
    out = list(command)
    for i, arg in enumerate(out[1:], start=1):
        if arg.startswith("-") or Path(arg).is_absolute() or not arg.lower().endswith((".py", ".pyw", ".js", ".mjs", ".cjs")):
            continue
        for root in (cwd, base, base.parent):
            candidate = root / arg
            if candidate.is_file():
                out[i] = str(candidate)
                break
    return out


def _resolve_registry_path(raw: str, base: Path) -> Path:
    """A path written in the registry: absolute stays as it is; a relative one is looked up next to
    `servers.json` first, then in the project root one level up — so `mcp/terminal/mcp_server.py`
    works as written from either place."""
    path = Path(raw.strip())
    if path.is_absolute():
        return path
    for root in (base, base.parent):
        if (root / path).exists():
            return root / path
    return base / path  # nothing there: the caller reports the path exactly as written


def load_config(path: Path) -> tuple[list[ServerConfig], int | None]:
    """Reads servers.json. Any problem is reported as a ValueError with a message the user can understand."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8-sig"))  # utf-8-sig: tolerates the BOM that PowerShell writes
    except json.JSONDecodeError as err:
        raise ValueError(f"malformed JSON (line {err.lineno}, column {err.colno}): {err.msg}") from err
    except OSError as err:
        raise ValueError(f"could not read {Path(path).name}: {err.strerror or err}") from err
    entries = data if isinstance(data, list) else (data.get("servers") if isinstance(data, dict) else None)
    if not isinstance(entries, list):
        raise ValueError('the "servers": [ ... ] list is missing')
    # Optional: restrict the WebSocket/control ports to exactly these extension ids. The default is the id
    # pinned by the manifest (or WMB_EXTENSION_IDS for a custom build) — never a bare chrome-extension:// prefix.
    extension_ids = _extension_ids_from_env()
    configured_ids = data.get("allowed_extension_ids") if isinstance(data, dict) else None
    if configured_ids is not None:
        if not isinstance(configured_ids, list) or not configured_ids:
            raise ValueError('"allowed_extension_ids" must be a non-empty list of extension ids')
        cleaned = tuple(_clean_extension_id(x) for x in configured_ids)
        if not all(cleaned):
            raise ValueError('"allowed_extension_ids" entries must be 32 characters a-p (a Chrome extension id)')
        extension_ids = cleaned
    base = Path(path).resolve().parent
    configs: list[ServerConfig] = []
    names: set[str] = set()
    for n, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            raise ValueError(f"server #{n} must be an object {{ ... }}")
        if entry.get("disabled") or entry.get("enabled") is False:
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f'server #{n} has no "name"')
        label = f'"{name}"'
        if name in names:
            raise ValueError(f"the name {label} is duplicated")
        names.add(name)
        server_path = entry.get("server_path")
        command = entry.get("command")
        if server_path and command:
            raise ValueError(f'{label}: use either "server_path" or "command", not both')
        if isinstance(server_path, str) and server_path.strip():
            script = _resolve_registry_path(server_path, base)
            if not script.is_file():
                raise ValueError(f'{label}: there is no server script at "{server_path}"')
            argv = [sys.executable, str(script)]  # this very interpreter runs the server
        elif isinstance(command, str) and command.strip():
            try:
                argv = shlex.split(command, posix=not WIN)
            except ValueError as err:
                raise ValueError(f'{label}: malformed "command" ({err})') from err
            if WIN:
                # posix=False keeps the quotes INSIDE the tokens ("C:\path with spaces\x.exe" --flag), and
                # CreateProcess would then take them for part of the name. Windows rules: the quotes around a
                # token are decoration, so they are stripped here.
                argv = [a[1:-1] if len(a) >= 2 and a[0] == '"' and a[-1] == '"' else a for a in argv]
        elif isinstance(command, list) and command and all(isinstance(c, (str, int, float)) for c in command):
            argv = [str(c) for c in command]
        else:
            raise ValueError(f'{label}: give a "server_path" (the MCP server script) or a "command"')
        try:
            port = int(entry["port"])
        except (KeyError, TypeError, ValueError):
            raise ValueError(f'{label}: "port" is missing (a number, for example 8080)') from None
        if not 1 <= port <= 65535:
            raise ValueError(f'{label}: "port" must be between 1 and 65535')
        env = entry.get("env") or {}
        if not isinstance(env, dict):
            raise ValueError(f'{label}: "env" must be an object {{ "VARIABLE": "value" }}')
        # A non-string "host" (a typo like 127.0.01 is a string and fails later at bind time; a NUMBER or a
        # dict would raise TypeError deep inside ws_serve: it would kill the whole bridge at startup, or kill
        # the hot-reload watcher silently) — so the type is checked here, where a readable error is possible.
        host = entry.get("host", "127.0.0.1")
        if not isinstance(host, str) or not host.strip():
            raise ValueError(f'{label}: "host" must be a text like "127.0.0.1" ("0.0.0.0" to listen on all interfaces)')
        host = host.strip()
        cwd = str(_resolve_registry_path(entry["cwd"], base).resolve()) if isinstance(entry.get("cwd"), str) and entry["cwd"].strip() else str(base)
        resolved = _resolve_script_args(argv, Path(cwd), base)
        guide_path = entry.get("guide_path")
        if isinstance(guide_path, str) and guide_path.strip():
            guide = _resolve_registry_path(guide_path, base)
            if not guide.is_file():
                raise ValueError(f'{label}: there is no guide file at "{guide_path}"')
        else:
            guide = None
        configs.append(ServerConfig(
            name=name,
            command=resolved,
            guide_path=guide,
            port=port,
            host=host,
            cwd=cwd,
            env={str(k): str(v) for k, v in env.items()},
            extension_ids=extension_ids,
        ))
    control = data.get("control_port") if isinstance(data, dict) else None
    try:
        return configs, (int(control) if control is not None else None)
    except (TypeError, ValueError):
        raise ValueError('"control_port" must be a number') from None

def load_all(config_path: Path | None) -> tuple[list[ServerConfig], int | None, str | None]:
    """Reads the registry (servers.json). Returns (servers, control_port, error)."""
    if not config_path:
        return [], None, None
    try:
        configs, control = load_config(config_path)
    except ValueError as err:
        return [], None, str(err)
    return configs, control, None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="WebSocket <-> MCP (stdio) bridge for LongArm.",
        usage="%(prog)s [--port N] [--name NAME] -- COMMAND [ARGS...]\n       %(prog)s --config servers.json [--restart | --stop | --status | --reload]",
    )
    parser.add_argument("--config", type=Path, help="JSON registry of the MCP servers")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="127.0.0.1", help="For security, only 127.0.0.1 by default")
    parser.add_argument("--name", default="mcp", help="Name for the logs")
    parser.add_argument("--cwd", help="Working directory of the MCP server")
    parser.add_argument("--log-file", type=Path, help="Write the logs to this file (useful as a service)")
    parser.add_argument("--control-port", type=int, default=None,
                        help=f"Control/detection port (default: {DEFAULT_CONTROL_PORT} with --config, disabled for an ad-hoc server; 0 = disabled)")
    parser.add_argument("--restart", action="store_true", help="Restart the bridge (stops the previous one and starts a new one in the background)")
    parser.add_argument("--stop", action="store_true", help="Stop the bridge that is running")
    parser.add_argument("--status", action="store_true", help="Show the status of the servers")
    parser.add_argument("--reload", action="store_true", help="Ask the bridge to re-read servers.json")
    parser.add_argument("--detach", action="store_true", help="Start in the background and return control")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="Command that launches the MCP server (stdio)")
    return parser


def _setup_logging(args) -> None:
    level = logging.DEBUG if args.verbose else logging.INFO
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
    root.setLevel(level)
    if args.log_file:
        # A long-lived bridge used to grow bridge.log without limit: 5 MB × 2 old files is enough to debug
        # without ever filling the disk.
        handler = logging.handlers.RotatingFileHandler(args.log_file, maxBytes=5 * 1024 * 1024, backupCount=2, encoding="utf-8")
        handler.setFormatter(fmt)
        root.addHandler(handler)
    else:
        logging.basicConfig(level=level, format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")


def _print_status(port: int) -> bool:
    info = ctl(port, "GET", "/servers")
    if not info:
        print(f"The bridge is not running (control port {port}).")
        return False
    print(f"Bridge v{info.get('version')} running (pid {info.get('pid')}) - config: {info.get('config')}")
    if info.get("config_error"):
        print(f"  ! servers.json has an error: {info['config_error']}")
    for s in info["servers"]:
        mark = "OK " if s["status"] == "listening" else "ERR"
        print(f"  [{mark}] {s['name']:<22} {s['url']:<24} {s.get('error') or ''}")
    return True


def _stop_existing(control_port: int, ports: list[int]) -> None:
    """Stops the previous bridge: first gracefully (/shutdown), then by freeing its ports."""
    if ctl(control_port, "GET", "/health"):
        print("  - stopping the previous bridge...")
        ctl(control_port, "POST", "/shutdown")
        end = time.time() + 8
        while time.time() < end and ctl(control_port, "GET", "/health"):
            time.sleep(0.3)
    _free_old_bridges(ports + [control_port])  # old versions (without a control port) or hung ones
    time.sleep(0.5)


def _spawn_detached(args, config: Path, control_port: int) -> None:
    exe = sys.executable
    if WIN:
        pyw = Path(exe).with_name("pythonw.exe")
        exe = str(pyw) if pyw.exists() else exe
    log_file = args.log_file or (Path(config).resolve().parent / "bridge.log")
    argv = [exe, str(Path(__file__).resolve()), "--config", str(Path(config).resolve()), "--control-port", str(control_port), "--log-file", str(log_file)]
    if args.verbose:
        argv.append("-v")
    clean_env = {k: v for k, v in os.environ.items() if k != "WMB_SUPERVISED"}  # the new bridge is NOT under the supervisor
    kwargs: dict = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "close_fds": True, "env": clean_env}
    if WIN:
        kwargs["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED | NEW_GROUP | NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(argv, **kwargs)  # noqa: S603


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _setup_logging(args)

    if not args.config:
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if args.stop or args.status or args.reload or args.restart:
            parser.error("--stop/--status/--reload/--restart need --config servers.json")
        if not command:
            parser.error("give the MCP server command after `--` or use --config")
        cfg = ServerConfig(name=args.name, command=command, port=args.port, host=args.host, cwd=args.cwd,
                           extension_ids=_extension_ids_from_env())
        control = args.control_port or 0
        try:
            asyncio.run(run([cfg], control_port=control))
        except KeyboardInterrupt:
            log.info("Stopped.")
        except OSError as err:
            log.error("Could not open the port: %s", err)
            return 1
        return 0

    # An unreadable registry is still reported (the extension shows it and offers to open the file), but
    # it no longer stops the rest of the configuration from running.
    configs, file_control, initial_error = load_all(args.config)
    if initial_error:
        log.error("invalid servers.json: %s", initial_error)
        print(f"invalid servers.json: {initial_error}")
    if file_control is None:
        try:
            import re
            found = re.search(r"""["']control_port["']\s*:\s*(\d+)""", Path(args.config).read_text(encoding="utf-8-sig"))
            file_control = int(found.group(1)) if found else None
        except Exception:  # noqa: BLE001
            pass
    control = args.control_port if args.control_port is not None else (file_control if file_control is not None else DEFAULT_CONTROL_PORT)
    ports = [c.port for c in configs]
    alive = ctl(control, "GET", "/health") if control else None

    if args.status:
        return 0 if _print_status(control) else 1
    if args.reload:
        if not alive:
            print("The bridge is not running.")
            return 1
        ctl(control, "POST", "/reload", timeout=10)
        _print_status(control)
        return 0
    if args.stop:
        _stop_existing(control, ports)
        print("Bridge stopped.")
        return 0

    if args.restart:
        print("Restarting the bridge...")
        _stop_existing(control, ports)
    elif alive:
        print("A bridge is already running: reloading servers.json (use --restart to restart it fully).")
        ctl(control, "POST", "/reload", timeout=10)
        _print_status(control)
        return 0
    elif _free_old_bridges(ports, quiet=True):
        time.sleep(0.7)  # an old bridge (without a control port) held the ports: it was closed and we start the new one

    if args.restart or args.detach:
        _spawn_detached(args, args.config, control)
        end = time.time() + 20
        while time.time() < end and not ctl(control, "GET", "/health"):
            time.sleep(0.4)
        if not _print_status(control):
            print("It did not start in time: check bridge.log")
            return 1
        return 0

    wants_restart = False
    try:
        wants_restart = asyncio.run(run(configs, control_port=control, config_path=args.config, config_error=initial_error))
    except KeyboardInterrupt:
        log.info("Stopped.")
    except OSError as err:
        log.error("Could not open the port: %s", err)
        return 1
    if wants_restart:
        if SUPERVISED:
            log.info("Restart: the supervisor (start_bridge_loop) will bring the bridge back up.")
        else:
            log.info("Restart: starting a new bridge in the background.")
            _spawn_detached(args, args.config, control)
    return 0


if __name__ == "__main__":
    sys.exit(main())