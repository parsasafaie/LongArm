# <img src="assets/logo.png" alt="LongArm logo" width="40" height="40" align="absmiddle"> LongArm

**Use your local MCP servers with ChatGPT, Gemini, Claude Web and DeepSeek: no API keys, no extra subscriptions.**

LongArm lets the free web versions of those chats **use tools on your own computer**: read files, run commands, query your system. Nothing reaches your machine without passing the permission you set for that server, and every result is written back into the chat so the AI can continue.

> Only connect MCP servers you trust. A tool with filesystem access can read whatever you allow it to.

**Jump to:** [How it works](#how-it-works) · [Install](#installation) · [First use](#first-use) · [MCP servers](#mcp-servers) · [Troubleshooting](#something-not-working) · [Origin](#origin-of-this-project)

## How it works

Two pieces work together:

| Piece | What it is | Where it lives |
|---|---|---|
| **The extension** | Installed in your browser. It reads what the AI asks for, asks for your approval and shows the state of every server. | Chrome, Edge or Brave |
| **The bridge** | A small Python program that connects the extension to your tools (MCP servers) over a local WebSocket. | Your computer, in the background |

1. You ask the AI something in the chat.
2. The AI answers with one or more calls (single-line JSON blocks) asking for tools — several independent calls may travel in one message.
3. The extension asks whether you allow each one, runs them in order on your computer, and **pastes one result block per call back into the chat** so the AI can continue.

Everything happens on your computer: the extension talks only to the chat site you are using and to `localhost`. What runs on your machine, and the security behind it: [SECURITY.md](SECURITY.md).

## Requirements

| Requirement | How to check |
|---|---|
| **Chrome, Edge or Brave**, version 116 or newer | Menu, *About*. |
| **Python 3.9 or newer** for the bridge | In a terminal: `python --version` (macOS/Linux: `python3 --version`). If it is missing, install it from [python.org](https://www.python.org/downloads/); on Windows tick *Add Python to PATH*. |
| **This project on disk** | Do not delete or move the folder afterwards: the extension is loaded from it. |

Optional: **Node.js**, only for MCP servers you launch with `npx`.

## Installation

### Windows

1. Open the `server` folder and double-click **`install.cmd`**. Wait until it says *Done*: it installs what is missing (`websockets`), makes the bridge start automatically when you log in, and starts it now.
2. Open `chrome://extensions` (Edge: `edge://extensions`) → turn on **Developer mode** → **Load unpacked** → pick this project folder (the one containing `manifest.json`).
3. Open the extension from the toolbar: the top should read **Bridge connected** with a green dot, and your servers below.

### macOS and Linux

```bash
bash server/install.sh      # installs what is missing and registers the automatic start
                            # (the same thing by hand: python3 server/install_service.py)
```

The bridge then starts with your session (`launchd` on macOS, a user `systemd` unit on Linux). Load the extension as in step 2 above.

The popup's **Start / Stop** buttons need the *launcher* (port 8098). `install.cmd` installs it on Windows; on macOS and Linux it is not part of the automatic start, but you can run it yourself and those buttons start working:

```bash
python3 server/start_bridge_loop.pyw
```

**Restart** works either way (it asks the running bridge to restart itself). Without the launcher the bridge still runs; it just cannot be switched on from the popup.

## First use

The first server the bridge publishes switches itself on (while no other one is active), so the first run is: install the bridge, install the instructions, then chat.

1. Install and start the bridge (see [Installation](#installation)).
2. The repository ships one server (**terminal**), already registered in `server/servers.json` — once the bridge runs, the extension enables it automatically. Open the popup → **Servers** and it should already be there, connected. Servers you add later stay off until you enable them (unless you turn on *Enable discovered servers* in Settings).
3. Install the instructions **once per platform**, where the platform keeps instructions for the model (a Project, a custom GPT, or a Gemini Skill) — see [instructions/README.md](instructions/README.md).
4. Open [ChatGPT](https://chatgpt.com), [Gemini](https://gemini.google.com), [Claude](https://claude.ai) or [DeepSeek](https://chat.deepseek.com). In ChatGPT and Claude start the chat **inside** the Project; in Gemini add the skill to any chat with `/` (Gemini also applies it on its own when relevant).
5. Ask for something that needs a tool, for example: **"What time is it on this computer? Use your tools."**
6. The AI asks for a tool, a dialog opens over the page, and you approve it (a batch asks once per call).
7. The results are pasted into the chat and the AI answers you.

By default the permission is **Always ask**: nothing runs unless you approve it. You can change it per server, or for all of them at once.

## The panel and the popup

**In the page:** every supported chat gets a small floating bar at the bottom-left — the active MCPs and how many tools they expose. Clicking it opens the panel:

| What it shows | Detail |
|---|---|
| The MCPs | Each server with its state (connected / connecting / disconnected) and how many tools it exposes |
| The permission of each one | *Always allow* · *Always ask* · *Never allow*, for one server or for all of them |
| Calls waiting for you | With *Always ask* a dialog opens over the page for each call (a batch queues them one after another) with the call and its arguments; you press *Run*, *Always allow* or *Reject* (Escape refuses) |
| A short log | What is running right now (a call detected, a server reconnecting, an error) |

Drag the bar anywhere; double-click it to put it back in its corner.

**In the toolbar popup:** a small app with a side rail — **Servers**, **Activity** and **Settings** — a master switch at the bottom of the rail, and the version under the logo.

| Control | What it does |
|---|---|
| **Start / Stop** | Turns the bridge program on or off. *Stop* keeps it off until you start it again, even after a reboot. Needs the launcher. |
| **Restart** (circular arrow) | Closes and reopens the bridge. Use it after changing something, or if it got stuck. |
| **Edit servers.json** (file icon) | Opens the registry where your MCP servers are declared. Save it and the bridge reloads it by itself. |
| **Default permission** | One three-way control (*Allow* · *Ask* · *Deny*) for every server at once; unselected when they differ. |
| One **card per server** | Its switch, state, address and tool count, plus the same three-way control for that server alone. The highlighted left edge means enabled. |

The **Activity** page lists the calls that have been run (server, tool, outcome, time). The **Settings** page holds the extension's switches — *Enable discovered servers*, *Send results automatically*, *Keep the chat clean*, *Wake the tab if it gets stuck* — and the maximum characters per result. Its header has **Copy diagnostics**: a JSON snapshot (version, bridge, servers, settings, recent calls) for a bug report.

The switch at the bottom of the rail is the **master switch of the extension**, not the same as *Stop*: it only makes the extension stop acting (the toolbar badge shows `OFF`), while *Stop* closes the **program** on your computer.

## MCP servers

**Every MCP server is one entry in `server/servers.json`.** The repository ships with the **terminal** server already registered:

```json
{
  "servers": [
    {
      "name": "terminal",
      "server_path": "mcp/terminal/mcp_server.py",
      "guide_path": "mcp/terminal/guide.txt",
      "port": 8875,
      "cwd": ".."
    }
  ],
  "control_port": 8099
}
```

- **`name`** — what the AI calls the server in a tool call. Must be unique.
- **`server_path`** — the MCP server script (it speaks MCP over stdio, one JSON-RPC message per line); the bridge runs it with its own Python. For anything that is not a script — an `npx` package, an installed program — use **`command`** instead: a full command line, e.g. `"command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"]`. Exactly one of the two.
- **`guide_path`** — a short text file, **written for the AI**: what the server is for, when to use it, what it refuses (optional). Keep it small — it is read every time the AI asks for the tools. A complete example: [mcp/terminal/guide.txt](mcp/terminal/guide.txt).
- **`port`** — the local WebSocket port this server is published on. Unique per server.
- Also per server: `cwd` (default: the folder `servers.json` sits in), `env` (`{ "NAME": "value" }`), `host` (default `127.0.0.1`), `disabled` (`true` keeps it out).
- At the top level, `control_port` (default 8099) and `launcher_port` (default 8098) choose the bridge's control port and the launcher's port; `allowed_extension_ids` (optional list) restricts both to exactly those extension ids — by default the id pinned in the manifest.

Relative paths are looked up next to `servers.json` first, then in the project root one level up. Add or edit an entry, save (use **Edit servers.json** in the popup), and within about two seconds the bridge reloads and the server appears in the list — turn it on there and the AI can use it. [mcp/terminal/](mcp/terminal/) is a complete example to copy.

There is no hard limit on how many servers you enable, but every enabled server adds its tools and its guide to what the AI sees, so one at a time is recommended; the popup shows the approximate token cost.

## Supported chat sites

| Platform | Adapter |
|---|---|
| ChatGPT | `content_scripts/adapters/chatgpt.js` |
| Gemini | `content_scripts/adapters/gemini.js` |
| Claude | `content_scripts/adapters/claude.js` |
| DeepSeek | `content_scripts/adapters/deepseek.js` |

Perplexity, Le Chat and the rest are not supported yet: a new platform is a new adapter file (selectors plus, where needed, a scan loop). The internals — and what an adapter has to declare — are in [ARCHITECTURE.md](ARCHITECTURE.md).

## What it does

| Feature | Detail |
|---|---|
| **One registry** | `server/servers.json` is the single list of your MCP servers: add an entry, save, and it is live within seconds (no restart). |
| **Context control** | Enable only the servers you need; only their tools reach the model, and the popup shows the approximate token cost. |
| **Per-server permissions** | *Always allow* · *Always ask* (the default) · *Never allow*, globally or per server, in the popup and in the in-page panel. |
| **Nothing is dropped** | Images, audio and binary resources are attached to the chat as real files; long text is attached in full instead of being truncated. |
| **Reliable in the background** | No step depends on page timers, which browsers throttle in hidden tabs; delivery is verified and retried. |
| **Nothing is written into the chat** | The rules live in the Project (ChatGPT, Claude) or Skill (Gemini) you install once; the AI asks for the tool list itself with a `list_tools` call. The extension never injects instructions or reminders. |
| **The AI recovers on its own** | A wrong server or tool name is answered with the valid list; an unreadable call is answered with the exact parse reason. |
| **Clean chat** | Everything the extension types into the chat — results, the tool list, notices — is kept out of sight by default, and so is the AI's `mcp_call` message. The AI still receives all of it. |
| **Batch calls** | Several independent calls in one reply run in order and come back in one message, with one result block per call. A call that needs another's result goes in a later message. |
| **Compact prompt** | Tools are described as `name(param: type)` signatures instead of full JSON Schema. |
| **No runaway loops** | An identical call inside a 15-second window is answered from the previous result instead of running again; a model that keeps repeating it is halted with an explicit error. |

## Something not working?

| Symptom | Fix |
|---|---|
| The popup says **Bridge off** | Click *Start*. If the button is greyed out, run `server/install.cmd` (Windows) or `server/install.sh` (macOS/Linux), or start `server/start_bridge_loop.pyw` yourself. |
| **Launcher missing** | Normal the first time: install it once. |
| `python` is not recognized | Reinstall Python with *Add Python to PATH*, or try `py` instead of `python`. |
| `No module named pip` (during the install) | Ubuntu/Debian ship Python without pip: `sudo apt install python3-websockets` (simplest) or `sudo apt install python3-pip`, then run the installer again. The installer prints this itself. |
| **Port in use** | Click *Restart*. If it persists, give that entry a different `port` in `server/servers.json` and save. |
| A server shows **an error** | Check its `server_path` (or `command`) and `port`, and look at `server/bridge.log`. A server whose program is not installed cannot start. |
| **servers.json has an error** | A comma or a quote is misplaced. Fix it and save: the bridge reloads by itself. |
| The chat does not react, or the bar is missing | Reload the tab (F5) and check that the master switch in the popup rail is on. If the site changed its interface, see the adapter note in [ARCHITECTURE.md](ARCHITECTURE.md). |
| I moved or renamed the project folder | Run the installer again and reload the extension in `chrome://extensions`. |
| I want to remove everything | `python server/install_service.py --uninstall`, then remove the extension from the browser. |

## Advanced: the bridge from a terminal

On Windows double-click `server/bridge.cmd`; on Linux and macOS use `server/bridge.sh` — the same menu and the same actions: `start | restart | status | stop | reload`. The folder's files and logs are described in [server/README.md](server/README.md).

Or drive the Python programs directly (macOS/Linux: `python3`):

```bash
# Launcher: start, stop and restart the bridge
python server/start_bridge_loop.pyw --ctl start | stop | restart | status | quit

# The bridge itself
python server/mcp_ws_bridge.py --config server/servers.json --restart   # restart (closes the old one even if it holds a port)
python server/mcp_ws_bridge.py --config server/servers.json --status    # status of every server
python server/mcp_ws_bridge.py --config server/servers.json --reload    # re-read the registry
python server/mcp_ws_bridge.py --config server/servers.json --stop      # stop the bridge

# One server, without the registry
python server/mcp_ws_bridge.py --port 8081 --name terminal -- python mcp/terminal/mcp_server.py
```

## Security

Nothing leaves your machine: the bridge listens on `127.0.0.1` only and refuses web-page origins and every extension except LongArm's own id, every call — including each member of a batch — needs your approval by default, results are framed as data so prompt injection inside them cannot run tools, and the approval dialog shows the call's arguments in full. The complete model — what is protected, what is not, and what to review before connecting a server: [SECURITY.md](SECURITY.md).

## Development

```bash
npm test              # the whole suite: JS checks + parser/protocol/hide/background tests + the Python side
npm run check         # the quick gate: every JS file parses, manifest/version/icon consistency
npm run instructions  # regenerate instructions/instructions.txt from content_scripts/prompt_builder.js
npm run constants     # regenerate content_scripts/constants.js from shared/constants.js
npm run release       # bump the version in its three extension-side homes, regenerate, check (or: node scripts/release.mjs patch)
npm run pack          # dist/longarm/ + dist/longarm.zip (Chrome/Edge/Brave)
python3 scripts/build.py chrome  # the same package without Node (Python's own zipfile)
python3 scripts/make_icons.py    # regenerate icons/ from assets/logo.png (needs Pillow, a dev-only dependency)
```

Two files are generated and checked for staleness, so a shared value or the instruction text only ever changes in one place: `instructions/instructions.txt` and `content_scripts/constants.js`. The suite runs on Ubuntu and Windows; the Python part finds its interpreter itself, so `npm test` works wherever Python 3.9+ is installed.

`scripts/` holds development-only tooling — nothing in it ships inside the extension or runs on a user's machine; each file is described in [scripts/README.md](scripts/README.md). The full technical map (data flow, parser layers, timing, storage, the bridge internals, what each test pins, the release pattern): [ARCHITECTURE.md](ARCHITECTURE.md).

## Contributing

Issues and pull requests are welcome: new adapters, new MCP servers, fixes. Security issues go through the private channel described in [SECURITY.md](SECURITY.md), never a public issue.

## Origin of this project

The original idea and the first implementation come from
[github.com/AstraxOf/web-mcp-bridge](https://github.com/AstraxOf/web-mcp-bridge).
This version is built on that work and has its own changes and improvements.

MIT License. See [LICENSE](LICENSE).
