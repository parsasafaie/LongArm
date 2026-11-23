#!/usr/bin/env python3
"""
test_mcp_server.py - tests for mcp_server.py, spoken over stdio exactly like the bridge.

    python mcp/terminal/test_mcp_server.py

No dependencies: plain `python` (3.9+) is enough. Every case spawns the real server and sends it
JSON-RPC lines, so this checks the same path the extension uses (minus the WebSocket).
"""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "mcp_server.py"
PY = sys.executable


def py(code: str) -> str:
    """Command line that runs `code` with this same interpreter, quoted for cmd.exe and /bin/sh."""
    return f'"{PY}" -c "{code}"'


class Server:
    """Same conversation the bridge has: JSON-RPC, one message per line, UTF-8 both ways."""

    def __init__(self, *args, stderr_path: Path):
        self.log = open(stderr_path, "a", encoding="utf-8")
        self.log.write(f"\n=== server {' '.join(args)} ===\n")
        self.log.flush()
        self.proc = subprocess.Popen(
            [PY, str(SERVER), *args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        self.lines: "queue.Queue" = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.next_id = 0

    def _read(self) -> None:
        for line in self.proc.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def rpc(self, method: str, params: dict = None, timeout: float = 25) -> dict:
        self.next_id += 1
        msg = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params:
            msg["params"] = params
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        while True:
            try:
                line = self.lines.get(timeout=timeout)
            except queue.Empty:
                raise AssertionError(f"the server never answered {method!r} (id {self.next_id})") from None
            assert line is not None, f"the server closed stdout while answering {method!r}"
            reply = json.loads(line)
            if reply.get("id") == self.next_id:
                return reply

    def call(self, tool: str, **args) -> tuple:
        """-> (text the AI would read, isError)"""
        result = self.rpc("tools/call", {"name": tool, "arguments": args})["result"]
        return result["content"][0]["text"], result["isError"]

    def __enter__(self) -> "Server":
        return self

    def __exit__(self, *_exc) -> None:
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001 - a stuck server must not hide the real failure
            self.proc.kill()
        self.log.close()


def run_tests(tmp: str, stderr_path: Path) -> None:
    with Server("--cwd", tmp, "--timeout", "5", stderr_path=stderr_path) as srv:
        # --- handshake and tool listing (the extension's own sequence)
        init = srv.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                      "clientInfo": {"name": "test", "version": "0"}})["result"]
        assert init["serverInfo"]["name"] == "terminal-mcp", init
        assert init["capabilities"] == {"tools": {}}, init
        assert srv.rpc("ping")["result"] == {}
        assert srv.rpc("resources/list")["error"]["code"] == -32601

        tools = srv.rpc("tools/list")["result"]["tools"]
        assert {t["name"] for t in tools} == {"run_command", "terminal_info"}, tools
        run = next(t for t in tools if t["name"] == "run_command")
        assert run["inputSchema"]["required"] == ["command"], run
        assert set(run["inputSchema"]["properties"]) == {"command", "cwd", "timeout"}, run
        assert run["description"], run

        # --- terminal_info reports the folder configured with --cwd
        text, is_error = srv.call("terminal_info")
        assert not is_error and tmp in text, text

        # --- a normal command: exit code and stdout
        text, is_error = srv.call("run_command", command="echo hello-terminal")
        assert not is_error and "exit code: 0" in text and "hello-terminal" in text, text

        # --- stderr comes separated from stdout
        text, _ = srv.call("run_command", command=py("import sys; sys.stderr.write('boom')"))
        assert "--- stderr ---" in text and "boom" in text, text

        # --- a failing command is not a tool error: the AI still reads the output and the code
        text, is_error = srv.call("run_command", command=py("import sys; sys.exit(3)"))
        assert "exit code: 3" in text and not is_error, text

        # --- the `cwd` argument decides where it runs
        text, _ = srv.call("run_command", command=py("import os; print(os.path.realpath(os.getcwd()))"), cwd=tmp)
        assert os.path.realpath(tmp) in text, text

        # --- stdin is closed: a command that reads input ends immediately instead of eating the protocol
        text, _ = srv.call("run_command", command=py("import sys; print(repr(sys.stdin.read()))"))
        assert "''" in text, text
        assert srv.rpc("ping")["result"] == {}, "the server stopped answering after that command"

        # --- timeout: the process is killed and the report says so
        started = time.monotonic()
        text, _ = srv.call("run_command", command=py("import time; time.sleep(30)"), timeout=1)
        elapsed = time.monotonic() - started
        assert "TIMED OUT" in text, text
        assert "may have partially run" in text, "a timeout must warn about partial side effects"
        assert elapsed < 15, f"the timeout took {elapsed:.1f} s"

        # --- a missing folder is a clear error, not a crash
        text, is_error = srv.call("run_command", command="echo nope", cwd=os.path.join(tmp, "does-not-exist"))
        assert is_error and "there is no folder" in text, text

        # --- an empty command is refused
        text, is_error = srv.call("run_command", command="   ")
        assert is_error and "empty" in text, text

        # --- unknown tool
        text, is_error = srv.call("nope")
        assert is_error and "unknown tool" in text, text

    # --- a long output is clipped and says how much was dropped; past the read cap, the rest is not collected
    with Server("--cwd", tmp, "--max-output", "100", stderr_path=stderr_path) as big:
        text, _ = big.call("run_command", command=py("print('x' * 500)"))
        assert "characters omitted" in text, text
        assert "read cap" in text, text

    # --- the AI cannot ask for more time than --max-timeout allows
    with Server("--cwd", tmp, "--timeout", "2", "--max-timeout", "2", stderr_path=stderr_path) as capped:
        text, _ = capped.call("run_command", command="echo hi", timeout=600)
        assert "timeout capped to 2 s" in text and "exit code: 0" in text, text

    # --- deny rules refuse matching commands and let the rest through
    with Server("--cwd", tmp, "--deny", "forbidden", stderr_path=stderr_path) as denied:
        text, is_error = denied.call("run_command", command="echo forbidden-thing")
        assert is_error and "refused" in text, text
        text, _ = denied.call("run_command", command="echo allowed")
        assert "exit code: 0" in text and "allowed" in text, text

    # --- the CLI itself
    out = subprocess.run([PY, str(SERVER), "--version"], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0 and "terminal-mcp" in out.stdout, out
    out = subprocess.run([PY, str(SERVER), "--timeout", "0"], capture_output=True, text=True, timeout=30)
    assert out.returncode != 0 and "greater than 0" in out.stderr, out


def main() -> None:
    tmp = tempfile.mkdtemp(prefix="terminal-mcp-test-")
    stderr_path = Path(tmp) / "server-stderr.log"
    try:
        run_tests(tmp, stderr_path)
    except Exception:
        sys.stderr.write(f"\n--- server stderr ({stderr_path}) ---\n"
                         f"{stderr_path.read_text(encoding='utf-8', errors='replace')}\n")
        raise
    print("✔ test_mcp_server: everything works")


if __name__ == "__main__":
    main()
