"""Test of the launcher (start_bridge_loop.pyw): Start/Stop/Restart control, .paused flag, Origin/Host security and supervisor."""
import http.client
import importlib.machinery
import importlib.util
import json
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER_PORT = 18798
DEAD_CONTROL = 18797  # nobody listens here: the bridge "does not exist"

loader = importlib.machinery.SourceFileLoader("wmb_launcher", str(ROOT / "server/start_bridge_loop.pyw"))
spec = importlib.util.spec_from_loader("wmb_launcher", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)

tmp = Path(tempfile.mkdtemp(prefix="wmb_launcher_"))
cfg = tmp / "servers.json"
cfg.write_text(json.dumps({"servers": [], "control_port": DEAD_CONTROL, "launcher_port": LAUNCHER_PORT}), encoding="utf-8")
paused_file = tmp / ".paused"
spawned = []


def fake_spawn(_launcher):
    spawned.append(time.time())
    return 0


launcher = mod.Launcher(config=str(cfg), paused_file=str(paused_file), spawn=fake_spawn)
assert launcher.launcher_port == LAUNCHER_PORT and launcher.control_port == DEAD_CONTROL
server = mod.make_server(launcher)
threading.Thread(target=server.serve_forever, daemon=True).start()


def call(method, path, origin=None, host=None):
    conn = http.client.HTTPConnection("127.0.0.1", LAUNCHER_PORT, timeout=5)
    headers = {}
    if origin:
        headers["Origin"] = origin
    if host:
        headers["Host"] = host
    conn.request(method, path, headers=headers, body=b"" if method == "POST" else None)
    res = conn.getresponse()
    raw = res.read()
    conn.close()
    return res.status, (json.loads(raw) if raw else None)


def wait_for(cond, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


# --- status and security ---
st, body = call("GET", "/status")
assert st == 200 and body["launcher"] is True and body["paused"] is False and body["bridge"] is False, (st, body)
EXT = f"chrome-extension://{mod.DEFAULT_EXTENSION_ID}"
assert call("GET", "/status", origin=EXT)[0] == 200
assert call("GET", "/status", origin="chrome-extension://abcdef")[0] == 403    # another extension is NOT trusted
assert call("GET", "/status", origin="https://chatgpt.com")[0] == 403          # a website can NOT control the launcher
assert call("POST", "/stop", origin="https://evil.example")[0] == 403
assert call("GET", "/status", host="evil.example:8098")[0] == 403               # DNS rebinding
assert call("GET", "/nope")[0] == 404
assert not paused_file.exists()
print("OK status and security")

# --- stop / start / restart ---
st, body = call("POST", "/stop", origin=EXT)
assert st == 200 and body["paused"] is True and paused_file.exists(), (st, body)
assert launcher.paused is True
st, body = call("POST", "/start")
assert st == 200 and body["paused"] is False and not paused_file.exists(), (st, body)
call("POST", "/stop")
st, body = call("POST", "/restart")                                             # restart also "turns it on"
assert st == 200 and body["paused"] is False and not paused_file.exists()
print("OK start / stop / restart")

# --- supervisor: does not start if paused; starts if the bridge does not respond ---
launcher.set_paused(True)
thread = threading.Thread(target=launcher.supervise, daemon=True)
thread.start()
time.sleep(1.5)
assert spawned == [], "while stopped the bridge must not start"
call("POST", "/start")
assert wait_for(lambda: len(spawned) >= 1), "on start the bridge must be started"
print("OK supervisor")

# --- stop while the bridge child is still starting: it is terminated, not left behind ---
class StuckProc:
    def __init__(self):
        self.terminated = False
        self.killed = False
    def poll(self):
        return None
    def wait(self, timeout=None):
        raise mod.subprocess.TimeoutExpired("bridge", timeout)
    def terminate(self):
        self.terminated = True
    def kill(self):
        self.killed = True

stuck = StuckProc()
launcher.proc = stuck
launcher.do_stop()
assert stuck.terminated or stuck.killed, "Stop during spawn must terminate the child"
launcher.proc = None
call("POST", "/start")
print("OK stop during spawn")

# --- quit ---
st, body = call("POST", "/quit")
assert st == 200 and body["bye"] is True
assert wait_for(launcher.quit.is_set)
thread.join(timeout=5)
assert not thread.is_alive(), "the supervisor must stop with /quit"
server.server_close()
print("OK test_launcher")