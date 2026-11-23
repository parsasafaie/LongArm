"""Integration test: WebSocket → bridge → MCP server over stdio (the fixture in tests/fixtures)."""
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
PORT = 18765
# Pinned by manifest.json `key`: the bridge accepts THIS id, never any chrome-extension:// origin.
EXTENSION_ID = "ilnjjdjoklladplnidbfmcjgalkmigjn"


async def rpc(ws, msg_id, method, params=None):
    await ws.send(json.dumps({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}}))
    while True:
        reply = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if reply.get("id") == msg_id:
            return reply


async def main():
    url = f"ws://127.0.0.1:{PORT}"

    # Client without Origin (CLI): allowed
    async with websockets.connect(url) as ws:
        init = await rpc(ws, 1, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})
        assert init["result"]["serverInfo"]["name"] == "test-mcp", init
        await ws.send(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}))

        assert (await rpc(ws, 2, "ping"))["result"] == {}

        tools = (await rpc(ws, 3, "tools/list"))["result"]["tools"]
        assert {t["name"] for t in tools} == {"system_info", "current_time", "add", "echo", "sleep"}, tools

        res = (await rpc(ws, 4, "tools/call", {"name": "add", "arguments": {"a": 2, "b": 40}}))["result"]
        assert res["content"][0]["text"] == "42", res

        res = (await rpc(ws, 5, "tools/call", {"name": "echo", "arguments": {"text": "naïve ✓"}}))["result"]
        assert res["content"][0]["text"] == "naïve ✓", res

    # Origin from a website: must be rejected
    try:
        async with websockets.connect(url, origin="https://chatgpt.com") as ws:
            await asyncio.wait_for(ws.recv(), 3)
        raise AssertionError("A website should NOT be able to connect")
    except (websockets.exceptions.ConnectionClosed, websockets.exceptions.InvalidStatus, websockets.exceptions.InvalidHandshake):
        pass

    # ANOTHER extension: must be rejected (the old prefix check accepted it and ran tools)
    try:
        async with websockets.connect(url, origin="chrome-extension://abcdefghijklmnop") as ws:
            await asyncio.wait_for(ws.recv(), 3)
        raise AssertionError("A different extension should NOT be able to connect")
    except (websockets.exceptions.ConnectionClosed, websockets.exceptions.InvalidStatus, websockets.exceptions.InvalidHandshake):
        pass

    # The project extension (its id is pinned by the manifest key): allowed
    async with websockets.connect(url, origin=f"chrome-extension://{EXTENSION_ID}") as ws:
        assert (await rpc(ws, 1, "ping"))["result"] == {}

        # Hard cancellation: notifications/cancelled stops the tool child and closes the connection
        # (MCP's cancellation is advisory; a sleeping command would otherwise outlive the page).
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                                  "params": {"name": "sleep", "arguments": {"seconds": 30}}}))
        await asyncio.sleep(0.3)
        await ws.send(json.dumps({"jsonrpc": "2.0", "method": "notifications/cancelled",
                                  "params": {"requestId": 7}}))
        try:
            await asyncio.wait_for(ws.recv(), 8)
        except websockets.exceptions.ConnectionClosed:
            pass  # the bridge stopped the child and closed this client
        else:
            raise AssertionError("a cancelled tool must stop the connection, not answer 30 s later")

    print("✔ test_bridge: all checks passed")


if __name__ == "__main__":
    bridge = subprocess.Popen(
        [sys.executable, str(ROOT / "server/mcp_ws_bridge.py"), "--port", str(PORT), "--name", "test", "--",
         sys.executable, str(ROOT / "tests/fixtures/test_mcp_server.py")],
        stderr=subprocess.DEVNULL,
        env={**os.environ, "WMB_EXTENSION_IDS": EXTENSION_ID},
    )
    try:
        time.sleep(1.5)
        asyncio.run(main())
    finally:
        try:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/PID", str(bridge.pid), "/F", "/T"], capture_output=True, timeout=2)
            else:
                bridge.terminate()
        except Exception:
            pass
        try:
            bridge.wait(timeout=2)
        except Exception:
            pass
