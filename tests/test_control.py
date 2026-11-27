"""Test of --config mode: control port, detection, hot reload, restart, servers.json errors and shutdown."""
import http.client
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = str(ROOT / "server/mcp_ws_bridge.py")
# Read from the bridge itself: the version is bumped there every release, and a hardcoded copy here only
# went stale and failed the release check.
VERSION = re.search(r'^VERSION = "([^"]+)"', Path(BRIDGE).read_text(encoding="utf-8"), re.M).group(1)
FIXTURE = str(ROOT / "tests/fixtures/test_mcp_server.py")
CONTROL = 18799
EXTENSION_ID = "ilnjjdjoklladplnidbfmcjgalkmigjn"  # pinned by manifest.json `key`
ENV = {**os.environ, "WMB_NO_OPEN": "1", "WMB_NO_MCP_SCAN": "1", "WMB_EXTENSION_IDS": EXTENSION_ID}
ENV.pop("WMB_SUPERVISED", None)


def entry(name, port):
    return {"name": name, "port": port, "command": [sys.executable, FIXTURE]}


def call(method, path, origin=None):
    req = urllib.request.Request(f"http://127.0.0.1:{CONTROL}{path}", method=method, data=b"" if method == "POST" else None)
    if origin:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")
    except OSError:
        return None, None


def wait_for(cond, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.3)
    return False


def names():
    status, body = call("GET", "/servers")
    return {s["name"]: s for s in body["servers"]} if status == 200 else {}


def spawn(args, env=ENV):
    return subprocess.Popen([sys.executable, BRIDGE, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)


def stop_everything():
    """Shuts down any bridge left behind on the test port."""
    if call("GET", "/health")[0] == 200:
        call("POST", "/shutdown")
        wait_for(lambda: call("GET", "/health")[0] is None, 10)


def main():
    stop_everything()
    with tempfile.TemporaryDirectory() as tmp:
        config = Path(tmp) / "servers.json"
        # BOM on purpose: PowerShell adds it and it used to break reading
        config.write_text(json.dumps({"servers": [entry("one", 18771), entry("two", 18772)]}), encoding="utf-8-sig")
        base = ["--config", str(config), "--control-port", str(CONTROL)]
        bridge = spawn(base)
        try:
            assert wait_for(lambda: call("GET", "/health")[0] == 200), "the control port did not start"
            found = names()
            assert set(found) == {"one", "two"} and all(s["status"] == "listening" for s in found.values()), found
            assert found["one"]["url"] == "ws://127.0.0.1:18771", found
            info = call("GET", "/servers")[1]
            assert info["config_error"] is None and info["version"] == VERSION, info

            # A website can NOT read or shut down the bridge
            assert call("GET", "/servers", origin="https://chatgpt.com")[0] == 403
            assert call("POST", "/shutdown", origin="https://evil.example")[0] == 403
            assert call("POST", "/restart", origin="https://evil.example")[0] == 403
            assert call("POST", "/open-config", origin="https://evil.example")[0] == 403
            assert call("GET", "/servers", origin="chrome-extension://abcdefghijklmnop")[0] == 403, "another extension is NOT trusted"
            assert call("GET", "/shutdown")[0] == 405
            assert call("GET", "/restart")[0] == 405
            assert call("GET", "/open-config")[0] == 405

            # Anti DNS-rebinding: a non-local Host is rejected
            conn = http.client.HTTPConnection("127.0.0.1", CONTROL, timeout=5)
            conn.request("GET", "/servers", headers={"Host": f"evil.example:{CONTROL}"})
            assert conn.getresponse().status == 403
            conn.close()

            # The project extension (its exact chrome-extension:// id) can open the file
            status, body = call("POST", "/open-config", origin=f"chrome-extension://{EXTENSION_ID}")
            assert status == 200 and body["ok"] and body["path"].endswith("servers.json"), (status, body)

            # Hot reload: a server is added and another removed without restarting
            config.write_text(json.dumps({"servers": [entry("one", 18771), entry("three", 18773)]}), encoding="utf-8")
            assert wait_for(lambda: set(names()) == {"one", "three"}), names()

            # A broken servers.json does NOT bring anything down: the previous state is kept and the error shows up in /servers
            config.write_text('{"servers": [ {"name": "one", "port": 18771, ', encoding="utf-8")
            assert wait_for(lambda: "malformed JSON" in ((call("GET", "/servers")[1] or {}).get("config_error") or "")), call("GET", "/servers")
            assert set(names()) == {"one", "three"} and names()["one"]["status"] == "listening"
            for bad, expected in [
                ({"servers": [{"name": "x", "command": ["python"]}]}, "port"),
                ({"servers": [{"name": "x", "port": 18775}]}, "command"),
                ({"servers": [{"name": "x", "port": 18775, "command": ["a"]}, {"name": "x", "port": 18776, "command": ["a"]}]}, "duplicated"),
                ({"servers": [{"port": 18775, "command": ["a"]}]}, "name"),
                ({"servers": "not a list"}, "servers"),
            ]:
                config.write_text(json.dumps(bad), encoding="utf-8")
                assert wait_for(lambda: expected in ((call("GET", "/servers")[1] or {}).get("config_error") or "")), (bad, call("GET", "/servers")[1])
            # Once fixed, the error disappears on its own
            config.write_text(json.dumps({"servers": [entry("one", 18771), entry("three", 18773)]}), encoding="utf-8")
            assert wait_for(lambda: (call("GET", "/servers")[1] or {}).get("config_error") is None), call("GET", "/servers")

            # A second `--config` with the bridge running reloads instead of failing with "port busy"
            again = subprocess.run([sys.executable, BRIDGE, *base], capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL, env=ENV)
            assert again.returncode == 0 and "A bridge is already running" in again.stdout, again.stdout + again.stderr

            # A port taken by another program does not bring down the rest
            blocker = socket.socket()
            blocker.bind(("127.0.0.1", 18774))
            blocker.listen(1)
            config.write_text(json.dumps({"servers": [entry("one", 18771), entry("busy", 18774)]}), encoding="utf-8")
            assert wait_for(lambda: names().get("busy", {}).get("status") == "error"), names()
            assert names()["one"]["status"] == "listening"
            blocker.close()

            # RESTART from the control port (no supervisor): the bridge closes and a NEW one starts (different pid)
            old_pid = call("GET", "/health")[1]["pid"]
            assert call("POST", "/restart")[0] == 200
            assert bridge.wait(timeout=20) == 0
            assert wait_for(lambda: (call("GET", "/health")[1] or {}).get("pid") not in (None, old_pid), 30), "it did not start again"
            assert wait_for(lambda: names().get("one", {}).get("status") == "listening", 20), names()

            # Clean shutdown through the control port
            assert call("POST", "/shutdown")[0] == 200
            assert wait_for(lambda: call("GET", "/health")[0] is None, 15)
        finally:
            if bridge.poll() is None:
                bridge.terminate()
                bridge.wait(timeout=5)
            stop_everything()

        # With a supervisor (start_bridge_loop): on restart the process ends and does NOT launch another one (the supervisor does)
        config.write_text(json.dumps({"servers": [entry("one", 18771)]}), encoding="utf-8")
        supervised = spawn(base, env={**ENV, "WMB_SUPERVISED": "1"})
        try:
            assert wait_for(lambda: call("GET", "/health")[0] == 200)
            assert call("GET", "/servers")[1]["supervised"] is True
            assert call("POST", "/restart")[0] == 200
            assert supervised.wait(timeout=20) == 0
            time.sleep(2.5)
            assert call("GET", "/health")[0] is None, "with a supervisor there must not be another stray bridge"
        finally:
            if supervised.poll() is None:
                supervised.terminate()
                supervised.wait(timeout=5)
            stop_everything()

        # Startup with a BROKEN servers.json: the bridge still comes up, reports the error and recovers when fixed
        config.write_text('{"servers": [ {"name": "one" ', encoding="utf-8")
        broken = spawn(base)
        try:
            assert wait_for(lambda: call("GET", "/health")[0] == 200), "with the file broken the bridge must still start"
            assert "malformed JSON" in call("GET", "/servers")[1]["config_error"]
            assert names() == {}
            config.write_text(json.dumps({"servers": [entry("one", 18771)]}), encoding="utf-8")
            assert wait_for(lambda: names().get("one", {}).get("status") == "listening"), names()
            assert call("GET", "/servers")[1]["config_error"] is None
            assert call("POST", "/shutdown")[0] == 200
            broken.wait(timeout=15)
        finally:
            if broken.poll() is None:
                broken.terminate()
                broken.wait(timeout=5)
            stop_everything()
    print("ok test_control: all checks passed")


if __name__ == "__main__":
    main()