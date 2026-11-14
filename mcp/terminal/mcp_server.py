#!/usr/bin/env python3
"""
mcp_server.py - minimal MCP server (stdio, no dependencies) that runs shell commands.

The AI asks for `run_command` through LongArm; this server runs the command line in a real
shell, waits for it to finish (or kills it when the timeout expires) and returns stdout, stderr
and the exit code. Standard library only, no dependencies.

    python mcp/terminal/mcp_server.py
    python mcp/terminal/mcp_server.py --cwd C:/Users/me --timeout 30
    python mcp/terminal/mcp_server.py --deny "^sudo " --deny "shutdown"

It is registered in server/servers.json and run with the interpreter the bridge runs under:

    { "name": "terminal", "server_path": "mcp/terminal/mcp_server.py",
      "guide_path": "mcp/terminal/guide.txt", "port": 8875 }

What the AI is told about the server is that guide file. To pass extra flags, use a "command" entry
instead of "server_path" in the registry.

Options (all optional; TERMINAL_MCP_CWD / _TIMEOUT / _MAX_TIMEOUT / _MAX_OUTPUT / _SHELL / _DENY
work as fallbacks, which is handy in the "env" block of servers.json):
    --cwd DIR         folder where commands run (default: the folder the server starts in)
    --timeout N       seconds to wait for each command (default: 60)
    --max-timeout N   ceiling for the AI's own `timeout` argument (default: 110, because the
                      extension abandons a tool call after 120 s: a longer wait would return nothing)
    --max-output N    characters kept of each stream, head and tail; what is past the read cap is
                      discarded (default: 20000)
    --shell PATH      shell that runs the commands (default: the platform's own: cmd.exe, /bin/sh)
    --deny REGEX      refuse commands matching this regular expression (repeatable; a guard, not a
                      sandbox: the real permission is the one you approve in the extension)

Security
--------
This is a terminal, not a sandbox: commands run with the permissions of the user who started the
bridge, so treat the server as "full access to my account". The real gate is the extension's
permission for it — keep that on "Always ask", or "Never allow" when you are not using it. --deny
is a guard against the commands you never want, never a boundary: a command can be written in
endless ways. Every command is logged to stderr, which the bridge keeps in server/bridge.log:
nothing is sent anywhere else.

Platform
--------
Windows: cmd.exe, killed with `taskkill /F /T`; no console window flashes. Linux/macOS: /bin/sh,
killed with `killpg(SIGKILL)`. Both kill the whole process tree when the timeout expires, and in
paths `/` works on Windows too (C:/Users/...).
"""
from __future__ import annotations

import argparse
import json
import locale
import os
import platform
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field

WIN = sys.platform == "win32"
VERSION = "1.0.0"
CREATE_NO_WINDOW = 0x08000000  # keeps cmd.exe from flashing a console window on Windows
DEFAULT_TIMEOUT = 60.0
DEFAULT_MAX_TIMEOUT = 110.0    # the extension gives up on a tool call after 120 s (shared/constants.js)
DEFAULT_MAX_OUTPUT = 20_000


@dataclass
class Settings:
    """What the CLI and the environment decide; a single call can only narrow it, never widen it."""

    cwd: str = os.getcwd()
    timeout: float = DEFAULT_TIMEOUT
    max_timeout: float = DEFAULT_MAX_TIMEOUT
    max_output: int = DEFAULT_MAX_OUTPUT
    shell: "str | None" = None
    deny: "list" = field(default_factory=list)


SETTINGS = Settings()  # replaced by main() once the arguments are known


# --------------------------------------------------------------------- helpers

def log(message: str) -> None:
    """Diagnostics go to stderr: stdout is reserved for JSON-RPC, and the bridge keeps stderr in bridge.log."""
    sys.stderr.write(f"[terminal-mcp] {message}\n")
    sys.stderr.flush()


def reply(msg_id, result=None, error=None) -> None:
    body = {"jsonrpc": "2.0", "id": msg_id}
    body.update({"error": error} if error else {"result": result})
    sys.stdout.write(json.dumps(body, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _decode(raw: bytes) -> str:
    """Bytes printed by the command -> text (utf-8 first, then the system's own encoding)."""
    for encoding in ("utf-8", locale.getpreferredencoding(False)):
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", "replace")


def _clip(text: str, limit: int) -> str:
    """Keeps the beginning and the end of a long output and says how much was dropped."""
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    tail = limit - head
    return f"{text[:head]}\n... [{len(text) - limit} characters omitted] ...\n{text[-tail:]}"


def _env_number(name: str, fallback, cast):
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return fallback
    try:
        return cast(raw.strip())
    except ValueError:
        log(f"ignoring {name}={raw!r}: it is not a number")
        return fallback


def _env_deny() -> list:
    return [item.strip() for item in re.split(r"[;\n]", os.environ.get("TERMINAL_MCP_DENY", "")) if item.strip()]


# ------------------------------------------------------------------ the command

def _spawn(command: str, cwd: str) -> subprocess.Popen:
    """Starts the command in a shell, with stdin closed so it can never eat MCP messages."""
    if SETTINGS.shell:  # an explicit shell wins over the platform default
        argv: "str | list" = [SETTINGS.shell, "/c" if WIN else "-c", command]
        extra = {"creationflags": CREATE_NO_WINDOW} if WIN else {"start_new_session": True}
    else:
        argv = command
        if WIN:
            extra = {"shell": True, "creationflags": CREATE_NO_WINDOW}
        else:
            extra = {"shell": True, "start_new_session": True}  # own process group: killpg takes the tree down
    return subprocess.Popen(
        argv, cwd=cwd, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, **extra,
    )


def _kill(proc: subprocess.Popen) -> None:
    """Kills the command and whatever it started (same taskkill /T trick the bridge uses)."""
    try:
        if WIN:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True, timeout=15, creationflags=CREATE_NO_WINDOW)
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:  # noqa: BLE001 - already dead or not ours: the plain kill below is enough
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def _timeout_for(value) -> tuple:
    """The AI's `timeout` argument, clamped to what this server allows. -> (seconds, note)."""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return SETTINGS.timeout, ""
    if seconds != seconds or seconds <= 0:  # NaN or nonsense
        return SETTINGS.timeout, ""
    if seconds > SETTINGS.max_timeout:
        return SETTINGS.max_timeout, f" (timeout capped to {SETTINGS.max_timeout:g} s)"
    return seconds, ""


def _report(code, out: bytes, err: bytes, elapsed: float, timeout: float, timed_out: bool, note: str,
            out_more: bool = False, err_more: bool = False) -> str:
    head = (f"TIMED OUT after {timeout:g} s - the process was killed (exit code: {code})"
            if timed_out else f"exit code: {code}")
    lines = [f"{head} ({elapsed:.2f} s){note}"]
    stdout = _clip(_decode(out), SETTINGS.max_output).rstrip("\n")
    stderr = _clip(_decode(err), SETTINGS.max_output).rstrip("\n")
    if stdout.strip():
        lines.append(f"--- stdout ---\n{stdout}")
    if stderr.strip():
        lines.append(f"--- stderr ---\n{stderr}")
    if not stdout.strip() and not stderr.strip():
        lines.append("(the command produced no output)")
    if out_more:
        lines.append("(stdout went past the read cap: everything past it was discarded)")
    if err_more:
        lines.append("(stderr went past the read cap: everything past it was discarded)")
    if timed_out:
        lines.append("(input is closed here, so only non-interactive commands work: anything waiting "
                     "for the keyboard ends up as a timeout)")
    return "\n".join(lines)


def _pump(stream, limit: int) -> tuple:
    """Drains one pipe to EOF, KEEPING at most `limit` bytes — the bridge's RAM is never the command's
    victim, and the command is never left blocked on a full pipe (it would die by its timeout for
    producing output nobody kept). Everything past the cap is read and discarded.
    Returns (bytes kept, whether anything was discarded)."""
    buf = bytearray()
    discarded = False
    while True:
        chunk = stream.read(65536)
        if not chunk:
            return bytes(buf), discarded
        room = limit - len(buf)
        if room <= 0:
            discarded = True
            continue
        buf += chunk[:room]
        if len(chunk) > room:
            discarded = True


def execute(command: str, cwd_arg=None, timeout_arg=None) -> str:
    """Runs one command and builds the report the AI reads. Raises ValueError if it was refused."""
    for pattern in SETTINGS.deny:
        if pattern.search(command):
            raise ValueError(f"the command was refused: it matches the deny rule {pattern.pattern!r} "
                             "configured in this MCP server")
    # A relative folder resolves against SETTINGS.cwd (the default folder the tool schema promises: "relative
    # to the default folder"), NOT against the process CWD — they only coincide when no --cwd /
    # TERMINAL_MCP_CWD was set, so the schema was lying exactly when it mattered.
    raw = os.path.expandvars(os.path.expanduser(cwd_arg or "."))
    cwd = os.path.abspath(raw if os.path.isabs(raw) else os.path.join(SETTINGS.cwd, raw))
    if not os.path.isdir(cwd):
        raise ValueError(f'there is no folder "{cwd}"')
    timeout, note = _timeout_for(timeout_arg)

    started = time.monotonic()
    try:
        proc = _spawn(command, cwd)
    except OSError as err:
        raise ValueError(f"the command could not be started: {err}") from err

    # Both streams are drained WHILE the command runs (a full pipe must never deadlock it), each capped:
    # the report would clip to --max-output anyway, so buffering megabytes buys nothing.
    limit = SETTINGS.max_output * 4  # bytes; headroom for the multibyte encodings before the char-level clip
    results: dict = {}

    def drain(key: str, stream) -> None:
        results[key] = _pump(stream, limit)

    readers = (threading.Thread(target=drain, args=("out", proc.stdout), daemon=True),
               threading.Thread(target=drain, args=("err", proc.stderr), daemon=True))
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill(proc)
        try:
            proc.wait(timeout=10)  # whatever it printed before dying is already in the readers
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
    for reader in readers:
        reader.join(5)
    out, out_more = results.get("out", (b"", False))
    err, err_more = results.get("err", (b"", False))
    code = proc.returncode if proc.returncode is not None else -1
    elapsed = time.monotonic() - started
    log(f"{'TIMEOUT' if timed_out else 'exit ' + str(code)} in {elapsed:.2f} s "
        f"(cwd={cwd}, limit={timeout:g} s): {command[:200]}")
    return _report(code, out, err, elapsed, timeout, timed_out, note, out_more, err_more)


def terminal_info() -> str:
    """Real facts about where the commands run, so the AI does not have to guess the platform."""
    shell = SETTINGS.shell or ("cmd.exe (platform default)" if WIN else "/bin/sh (platform default)")
    rows = [
        ("Machine", socket.gethostname()),
        ("System", f"{platform.system()} {platform.release()} ({platform.machine()})"),
        ("Shell", shell),
        ("Home folder", os.path.expanduser("~")),
        ("Default folder", SETTINGS.cwd),
        ("Timeout", f"{SETTINGS.timeout:g} s per command (maximum {SETTINGS.max_timeout:g} s)"),
        ("Output limit", f"{SETTINGS.max_output} characters per stream"),
        ("Date and time", time.strftime("%Y-%m-%d %H:%M:%S %z")),
    ]
    return "\n".join(f"{key}: {value}" for key, value in rows)


# --------------------------------------------------------------------- MCP part

def tool_list() -> list:
    """The tools the AI sees: the numbers come from the real configuration, not from constants."""
    return [
        {
            "name": "run_command",
            "description": (
                "Runs a command in this computer's shell and returns stdout, stderr and the exit code. "
                "Waits until it finishes or the timeout expires (then the process is killed and what it "
                "printed is returned). Non-interactive only: input is closed, so a command waiting for the "
                "keyboard ends up as a timeout. To leave something running use `&`/`nohup` (Linux, macOS) "
                "or `start /b` (Windows)."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Command line exactly as you would type it in a terminal: pipes, "
                                       "redirects and && work. In paths use / (also on Windows).",
                    },
                    "cwd": {
                        "type": "string",
                        "description": f"Folder to run it in (absolute, or relative to the default folder: {SETTINGS.cwd}).",
                    },
                    "timeout": {
                        "type": "number",
                        "default": round(SETTINGS.timeout, 1),
                        "minimum": 1,
                        "maximum": SETTINGS.max_timeout,
                        "description": f"Seconds to wait before killing it (default {SETTINGS.timeout:g}, "
                                       f"maximum {SETTINGS.max_timeout:g}).",
                    },
                },
                "required": ["command"],
            },
        },
        {
            "name": "terminal_info",
            "description": (
                "Where the commands run: system, shell, home and default folder, and the timeout and output "
                "limits. Call it first if you are not sure whether to write Windows or Linux/macOS commands."
            ),
            "inputSchema": {"type": "object", "properties": {}},
        },
    ]


def call_tool(name: str, args: dict) -> str:
    if name == "run_command":
        command = str(args.get("command") or "").strip()
        if not command:
            raise ValueError('"command" is empty: send the command line to run')
        return execute(command, args.get("cwd"), args.get("timeout"))
    if name == "terminal_info":
        return terminal_info()
    raise KeyError(name)


def serve() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as err:
            log(f"ignoring an unreadable message from the bridge: {err}")
            continue
        method, msg_id = msg.get("method"), msg.get("id")
        if msg_id is None:  # notification: nothing to answer
            continue
        if method == "initialize":
            reply(msg_id, {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "terminal-mcp", "version": VERSION},
            })
        elif method == "ping":
            reply(msg_id, {})
        elif method == "tools/list":
            reply(msg_id, {"tools": tool_list()})
        elif method == "tools/call":
            params = msg.get("params") or {}
            name = params.get("name")
            try:
                text = call_tool(name, params.get("arguments") or {})
                reply(msg_id, {"content": [{"type": "text", "text": text}], "isError": False})
            except KeyError as err:
                reply(msg_id, {"content": [{"type": "text", "text": f"Error: unknown tool {err}"}], "isError": True})
            except Exception as err:  # noqa: BLE001 - any failure is reported to the AI, never a crash
                log(f"{name}: {err}")
                reply(msg_id, {"content": [{"type": "text", "text": f"Error: {err}"}], "isError": True})
        else:
            reply(msg_id, error={"code": -32601, "message": f"Method not supported: {method}"})


# ------------------------------------------------------------------------- CLI

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mcp_server.py",
        description="MCP server (stdio) that runs shell commands on this computer and returns their output.",
        epilog='Register it in server/servers.json: {"name": "terminal", "port": 8081, '
               '"command": ["python", "mcp/terminal/mcp_server.py"]}',
    )
    parser.add_argument("--cwd", default=os.environ.get("TERMINAL_MCP_CWD") or os.getcwd(),
                        help="folder where commands run (default: the folder the server starts in)")
    parser.add_argument("--timeout", type=float,
                        default=_env_number("TERMINAL_MCP_TIMEOUT", DEFAULT_TIMEOUT, float),
                        help=f"seconds to wait for each command (default: {DEFAULT_TIMEOUT:g})")
    parser.add_argument("--max-timeout", type=float,
                        default=_env_number("TERMINAL_MCP_MAX_TIMEOUT", DEFAULT_MAX_TIMEOUT, float),
                        help=f"ceiling for the AI's own timeout argument (default: {DEFAULT_MAX_TIMEOUT:g})")
    parser.add_argument("--max-output", type=int,
                        default=_env_number("TERMINAL_MCP_MAX_OUTPUT", DEFAULT_MAX_OUTPUT, int),
                        help=f"characters kept of each stream (the rest is discarded: the report keeps "
                             f"the head and the tail, default: {DEFAULT_MAX_OUTPUT})")
    parser.add_argument("--shell", default=os.environ.get("TERMINAL_MCP_SHELL") or None,
                        help="shell that runs the commands (default: cmd.exe on Windows, /bin/sh elsewhere)")
    parser.add_argument("--deny", action="append", metavar="REGEX", default=None,
                        help="refuse commands matching this regular expression (repeatable)")
    parser.add_argument("--version", action="version", version=f"terminal-mcp {VERSION}")
    return parser


def main() -> None:
    global SETTINGS
    parser = build_parser()
    args = parser.parse_args()
    if args.timeout <= 0 or args.max_timeout <= 0:
        parser.error("--timeout and --max-timeout must be greater than 0")
    if args.max_output < 100:
        parser.error("--max-output must be at least 100 characters")
    patterns = args.deny if args.deny is not None else _env_deny()
    try:
        deny = [re.compile(pattern, re.IGNORECASE) for pattern in patterns]
    except re.error as err:
        parser.error(f"--deny has an invalid regular expression: {err}")
    SETTINGS = Settings(
        cwd=os.path.abspath(os.path.expanduser(args.cwd)),
        timeout=args.timeout,
        max_timeout=max(args.max_timeout, args.timeout),  # a default above the ceiling is the user's call
        max_output=args.max_output,
        shell=args.shell,
        deny=deny,
    )
    for stream in (sys.stdin, sys.stdout, sys.stderr):  # the bridge speaks UTF-8 in both directions
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    log(f"ready: cwd={SETTINGS.cwd} shell={SETTINGS.shell or 'platform default'} "
        f"timeout={SETTINGS.timeout:g} s" + (f" deny={[p.pattern for p in SETTINGS.deny]}" if SETTINGS.deny else ""))
    try:
        serve()
    except (BrokenPipeError, KeyboardInterrupt):  # the bridge closed: nothing left to do
        pass


if __name__ == "__main__":
    main()
