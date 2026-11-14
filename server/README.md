# server/

The local half of LongArm: the bridge that publishes your MCP servers to the browser, the launcher
that keeps it alive, the installers, and the registry (`servers.json`). This file is the map of the
folder and the day-to-day operations; installation for first use is in [../README.md](../README.md#installation),
and the internals are in [../ARCHITECTURE.md](../ARCHITECTURE.md) section 2.

## The files

| File | What it is |
|---|---|
| `mcp_ws_bridge.py` | The bridge: publishes every server registered in `servers.json` on a local WebSocket port, spawns each MCP server as a child process and pipes JSON-RPC to it. Also the terminal control (`--status`, `--restart`, `--reload`, `--stop`). |
| `start_bridge_loop.pyw` | The **launcher**: keeps the bridge running, restarts it when it exits, and gives the popup its Start/Stop/Restart (port 8098). |
| `install_service.py` | One-time setup: makes `websockets` available to Python, writes the registry if missing, and registers the automatic start (Startup `.vbs` on Windows, a launchd agent on macOS, a user systemd unit on Linux). `--uninstall` removes it. |
| `install.cmd` / `install.sh` | Double-click / run once — thin wrappers around `install_service.py`. |
| `bridge.cmd` / `bridge.sh` | The bridge control menu: `start`, `restart`, `status`, `stop`, `reload`. Also finds Python and installs the requirements if they are missing. |
| `servers.json` | **The registry** — the single list of your MCP servers. Ships with the `terminal` server registered; how to add entries is in [../README.md](../README.md#mcp-servers). |
| `requirements.txt` | The bridge's only dependency: `websockets`. |
| `bridge.log` / `loop.log` | What the bridge and the launcher printed (child-process stderr included). The first place to look when something is off. |

## Operating the bridge

The normal way is the **popup** (Start / Stop / Restart, *Edit servers.json*). From a terminal, these
are the same operations:

```bash
server/bridge.sh start | restart | status | stop | reload   # or double-click bridge.cmd on Windows
python server/start_bridge_loop.pyw --ctl start | stop | restart | status | quit
python server/mcp_ws_bridge.py --config server/servers.json --status
```

- **Stop** keeps the bridge off until you start it again (the launcher remembers through a `.paused`
  marker), while the extension's master switch only makes the extension stop acting.
- **The registry is hot**: save `servers.json` and within about two seconds the bridge starts, stops
  or restarts only the servers that changed. Nothing to click.
- **Ports:** each server gets the `port` from its entry; the bridge's control port is `8099` and the
  launcher's is `8098` (both configurable in `servers.json` as `control_port` / `launcher_port`).

## When it does not start

| Symptom | Fix |
|---|---|
| `ModuleNotFoundError: No module named 'websockets'` | Run the installer once (`install.cmd` / `install.sh`), or `pip install -r server/requirements.txt`. |
| `No module named pip` | Ubuntu/Debian ship Python without pip: `sudo apt install python3-websockets` or `sudo apt install python3-pip`, then run the installer again. |
| `invalid servers.json: …` | The file has a JSON error (a comma, a quote). Fix it and save — the bridge keeps the previous configuration until then. |
| `port N is busy by <program>` | Another program holds that port: change `port` in the entry, or close the program. The bridge keeps the other servers running. |
| The popup buttons are greyed out | The launcher is not running: start `start_bridge_loop.pyw` (or install it once). |
| The bridge will not come back after *Stop* | It is paused on purpose: press *Start* (or `--ctl start`). |
| Automatic start stopped working after moving the folder | The path is recorded in the service: run the installer again. |

## Removing it

```bash
python server/install_service.py --uninstall   # removes the automatic start (and stops what it started)
```

Then remove the extension from the browser. The project folder can be deleted afterwards; nothing was
installed outside it except the startup entry and the Python package the installer added.
