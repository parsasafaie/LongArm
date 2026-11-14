# Architecture

Technical notes for anyone changing this code: how the pieces fit, what talks to what, which values
live where, and the invariants the tests are guarding. The user-facing story is in [README.md](README.md);
this file is the other half.

```
┌────────────────────────┐        ┌───────────────────────────┐        ┌─────────────────────┐
│  Chat page (web AI)    │        │  Browser extension        │        │  Local machine      │
│                        │        │                           │        │                     │
│  ChatGPT / Gemini /    │  DOM   │  content scripts          │   WS   │  mcp_ws_bridge.py   │
│  Claude / DeepSeek     │◄──────►│  parse → queue → deliver  │◄──────►│  (one child process │
│                        │  chat  │  background service worker│ (127.0.│   per connection)   │
└────────────────────────┘        └───────────────────────────┘  0.1)  └─────────────────────┘
                                                                    stdio         stdio
                                                               ┌──────────────┐ ┌──────────────┐
                                                               │ mcp/terminal/│ │ your server  │
                                                               │ mcp_server.py│ │ (any MCP)    │
                                                               └──────────────┘ └──────────────┘
```

Two programs, one contract:

| Piece | Entry point | Role |
|---|---|---|
| **The extension** (JS, MV3) | `background/background.js` + content scripts | Watches the chat for `mcp_call`, gates every call on the permission, forwards it over WebSocket, writes the result back into the chat |
| **The bridge** (Python) | `server/mcp_ws_bridge.py` | Publishes every server registered in `server/servers.json` on a local WebSocket port and pipes JSON-RPC between that socket and the server's stdin/stdout |

Nothing else exists between them: no HTTP API besides the two local control ports, no cloud, no
storage outside the machine.

---

## 1. The extension

### 1.1 Load order and the `WMB` namespace

Content scripts cannot use ES modules, so they load as plain scripts in a fixed order
(`manifest.json`) and share everything through the single global `WMB` (`content_scripts/utils.js`):

1. `constants.js` — **generated** from `shared/constants.js` (`npm run constants`); the defaults,
   permission labels, result statuses and timeouts, so nothing drifts from the service worker.
2. `utils.js` — the namespace itself: `WMB.sleep` (routed through the service worker so hidden tabs
   do not throttle it), `WMB.bg`, `WMB.waitFor`, `WMB.hash` (djb2), selector helpers,
   `WMB.scanCallsText` (the strict reader), the result planner and the DOM writer.
3. `mcp_parser.js` — the lenient reader on top of the strict one (below).
4. `prompt_builder.js` — `WMB.instructionsText()` (the installable rules) and
   `WMB.toolsListText()`; `WMB.buildSignature()` hashes the instruction text and acts as the build id
   of the page (an old tab detects a reload of the extension and asks for F5).
5. `hide.js` — keeps the bridge's own text out of sight (display-only).
6. `ui_widget.js` — the floating panel and the approval dialog.
7. `call_registry.js` — the ONE semantic repeat-guard: identical calls are answered with the previous result instead of running again.
8. `adapters/base_adapter.js` + one platform adapter — DOM watching, sending, attaching files.
9. `core_bridge.js` — the controller that ties it all together.

`WMB` and the `wmb_*` storage keys are the internal codename (from the project's origin,
web-mcp-bridge). They are **not** renamed with the product: storage keys are load-bearing (a rename
would strand the user's servers and permissions), and they are invisible to users.

### 1.2 Background service worker

`background/background.js` keeps one `McpConnection` (`ws_client.js`) per enabled server:

- **One WebSocket per MCP server**, addressed as `ws://127.0.0.1:<port>`.
- Requests are multiplexed by JSON-RPC `id` into a `#pending` map; each request carries its own
  timeout (15 s default, 120 s for `tools/call` — `CALL_TIMEOUT_MS`).
- Handshake on connect: `initialize` → `notifications/initialized` → `tools/list` (with cursor
  pagination). `notifications/tools/list_changed` triggers a re-list.
- Keepalive: a `ping` every 20 s (8 s timeout); no reply ⇒ the socket is closed so the exponential
  backoff (1 s → 30 s + jitter) reconnects. `chrome.alarms` wakes the worker every 30 s to reconcile
  in case the worker slept.
- **Discovery**: `discoverServers()` probes the bridge's control port (`http://127.0.0.1:8099/servers`,
  throttled to one probe per 2.5 s / one discovery per 8 s) and reconciles the list with
  `chrome.storage.local` — new entries are added (`auto: true`; the first one is enabled right away
  while no other server is active, and the `autoEnableDiscovered` setting extends that to every
  discovery), and entries that disappeared from the bridge are removed again. The bridge is the source
  of truth for the URL too: an entry matching by port with a different scheme/host is healed to the
  published address. A server the user does not want is removed where it is registered (an entry out
  of `server/servers.json`) — not from the extension. Discovery is unconditional: there is no setting
  that turns it off.
- **Reload detection**: `onInstalled` stamps `wmb_epoch`; a running page whose stamp changes warns the
  user that it still runs the previous copy of the code and asks for F5 (the build-signature banner
  only covers changes to the instruction text).
- `callTool()` resolves the server by slug/name/id, checks the permission (`deny` ⇒ `rejected`),
  reconnects if needed and records the call in `wmb_history` (50 entries).
- The message router (`handleMessage`) is the only API surface for the popup and content scripts:
  `GET_STATE`, `GET_ACTIVE_TOOLS`, `CALL_TOOL`, `UPDATE_SETTINGS`, `SET_PERMISSION`, … plus the
  launcher/bridge control calls (`START_BRIDGE`, `RESTART_BRIDGE`, `OPEN_CONFIG`, …) that proxy to
  the two local HTTP ports.

### 1.3 Detection pipeline (adapters + parser)

`BaseAdapter.observeResponses()` (`adapters/base_adapter.js`) is one scan loop, shared by most
platforms. A platform adapter (`gemini.js`, `claude.js`, `deepseek.js`) only declares selectors and,
optionally, a message-key hint; **ChatGPT swaps in its own scan loop** (`chatgpt.js`), because its UI
puts calls in code viewers outside the message containers and they must be located by their TEXT.

- **Scan sources**: a `MutationObserver` (debounced 800 ms), a 1 s heartbeat (`WMB.sleep`, so it
  survives hidden tabs; 3 s when idle), focus/visibility wake-ups and a "stuck generating" detector
  (text stable 2.5 s while the stop button is up ⇒ treat the message as finished).
- **What is scanned**: after a 2.5 s baseline (only memorised, never run — page reloads must not
  re-fire old calls), only the *last* assistant message with text.
- **De-duplication**: every detected call gets an id `messageKey#n:hash` stored in the `executed`
  set (`sessionStorage`, last 500; ChatGPT keeps an in-memory map instead and forgets a call once it
  leaves the page, so repeating a task is never blocked by history). A same-message rescan (repaint,
  refocus) is ignored; a *real* repeat — the AI answered again after the result was delivered
  (`genSinceDelivery`) and repeated the call as its last message — gets a fresh `~r<n>` id and is
  processed again (then hits the repeat registry, section 1.4).
- **One call per message**: `extractMcpCalls()` may return several calls, but only `n === 0` reaches
  the controller, with `extra: calls.length - 1`. The result note tells the AI the others were
  ignored.
- `looksMalformed()` + `WMB.diagnoseMcp()` produce the `format_error` notice (exact reason), at most
  three in a row (`MAX_BAD_STREAK`); a wrong-but-plausible server name gets the active-server
  catalogue instead of silence (at most twice, `MAX_BAD_SERVER`); placeholders from the instructions
  (`<server>`, `example`, …) are ignored.

**The parser** (`mcp_parser.js`) reads a message in layers, first match wins:

| Layer | File | What it reads |
|---|---|---|
| 0 | `utils.js` | Normalisation: zero-width chars, odd spaces, HTML entities the renderer left |
| 0b | `mcp_parser.js` | Backslash pre-pass: the backslashes a Markdown renderer ate, doubled per string BEFORE anything parses — without it the strict layer would decode `C:\new` as `C:<newline>ew` (a valid JSON escape!) and run the wrong command. A string that holds a drive path gets every backslash run normalised to two; strings without one only get the escapes JSON would reject doubled |
| 1 | `utils.js` | Strict JSON `{"mcp_call": {...}}` with a balanced-brace scan |
| 2 | `mcp_parser.js` | Repair pass: raw newlines inside strings, unescaped/curly quotes, trailing commas |
| 3 | `mcp_parser.js` | Lenient reader (JSON5-ish: single quotes, unquoted keys, `True`/`False`/`None`, comments) and then *flags*: `server`/`name`/`arguments` located separately, each argument coerced by the tool schema |

A call is only accepted when its server and tool exist among the active MCPs — the flags layer would
otherwise match prose.

### 1.4 Execution path (core_bridge)

`core_bridge.js` processes detections through a single promise chain (`queue = queue.then(...)`) —
**strictly serial per tab**, so two calls never race for the composer.

```
detect → resolveCall (refresh state once if stale)
       → bridge.list_tools?  → answer inline, nothing runs
       → repeat registry hit? → replay the previous result + note, nothing runs
       → permission deny?    → NOT_ALLOWED text
       → permission ask?     → approval dialog (Run / Always allow / Reject; Escape refuses)
       → CALL_TOOL           → background → WebSocket → MCP server
       → result              → planResult → attach files? → sendToolResult (auto-send, verified)
```

- **Repeat registry** (`call_registry.js`): the ONE semantic dedup. It maps `hash(server, name, arguments)`
  → `{count, at, result}`; `REPEAT_CALLS = { windowMs: 15 min, max: 1 }`: a second identical call inside the
  window replays the previous result with an "it was NOT run again" note, and a refusal is cached too. The
  registry is cleared by a *real* user send (`noteUserSend`, `isTrusted` events only) and by any permission
  change. Memory is bounded: an expired entry is dropped, at most 50 calls are remembered (oldest out
  first), and a result too large to hold — attachments are base64 — is cached as a short notice instead
  of its payload. What stays OUT of it on purpose: the adapters' DOM bookkeeping (which element of the page already
  fired) — that is a property of the page's repaints, not of the conversation, and each platform's DOM
  behaves differently.
- **The tool list is never stale**: when the AI asks for `list_tools` and the controller has servers but no
  tools yet (the worker just restarted, a server is still connecting), it takes one fresh look first; if the
  list is still empty, the answer carries each server's live connection state instead of pretending nothing
  is registered.
- **Timeout ladder** (deliberately staggered so the side that owns a request reports its timeout):
  terminal tool cap 110 s → service worker `CALL_TIMEOUT_MS` 120 s → page watchdog 150 s →
  approval dialog 300 s. On the way down, the terminal kills the process tree at its cap; on the way up,
  a page timeout is reported as "it may still be running — check its effect first".
- **Reconnect-and-retry**: if the server was down *before* the call was sent, the controller waits
  for the reconnection (40 s) and retries twice; a disconnect mid-flight is never retried
  automatically (side effects).
- **Delivery** (`planResult` in `utils.js`): nothing is ever truncated — text goes inline (capped at
  `maxResultChars`, default 12 000), images/audio/blobs and overlong text go as **full attachments**;
  if the chat refuses attachments they are downloaded and the marker says so. The send itself is
  verified (composer emptied / generation started), retried, and if the tab is hidden the tab is
  brought forward for a moment (`focusFallback`).

### 1.5 Hiding protocol text (hide.js)

Display-only cleanup, on by default. It recognises the two kinds of text the bridge puts on a page:
`[MCP_RESULT …]` messages (the whole protocol) and the AI's pure `mcp_call` replies. Nothing is deleted
from the DOM; turning the option off restores everything byte for byte. Detection is selector-free
(XPath over text nodes) so a site redesign cannot break it.

Two site-shaped details it handles: a **label in front of the user's sent text** (Gemini renders
`You said [MCP_RESULT …]…` — a message that is a user turn, starts within 32 chars with the wrapper
and ends with `[/MCP_RESULT]` is hidden whole, label included), and **draft protection on the EDITABLE
itself** (`textarea`, `[contenteditable]`, `[role=textbox]`) — a bare `<form>` that wraps the
conversation does not grant it to the messages, or a whole chat would stay on screen. A result the
scanner could not hide is reported to the floating panel (at most once every 8 s) instead of failing
silently.

### 1.6 Adapters

A new platform is a new file under `content_scripts/adapters/` registering itself via
`WMB.registerAdapter`, declaring five selector lists (`composer`, `sendButton`, `assistantMessages`,
`userMessages`, `stopButton`) and an optional `fileInput`. Everything else (scan, parse, queue,
permissions, delivery, hiding) is inherited. `hide.js` reads `assistantMessages`/`userMessages` from
the adapter before every pass so cleanup and detection can never disagree about what a message is.

When a site changes its markup, the fix is usually one line: add the new selector at the **start**
of the matching list — the first match wins and the older selectors keep working as fallbacks.
ChatGPT is the exception: its calls are located by text (code viewers outside the message
containers), so it brings its own scan loop.

### 1.7 Local ports

| Port | Owner | Purpose |
|---|---|---|
| one per server | each entry in `server/servers.json` | declared in its entry; must be unique |
| `8099` | the bridge (control, HTTP) | `/health`, `/servers`, `/reload`, `/restart`, `/shutdown`, `/open-config` — extension origins only, mutations need POST |
| `8098` | the launcher (HTTP) | `/start`, `/stop`, `/restart`, `/status` — what the popup's buttons call; configurable with `"launcher_port"` |

---

## 2. The bridge (Python)

### 2.1 `server/mcp_ws_bridge.py`

- **`Supervisor`** holds the desired `ServerConfig` map and the live listeners; `apply()` diffs and
  starts/stops/restarts only what changed. A `--config servers.json` invocation against an already
  running bridge *reloads* it instead of failing on a busy port.
- **`handle_client`**: every WebSocket connection gets its **own MCP child process** (spawned with
  `CREATE_NO_WINDOW` on Windows, in its own process group elsewhere so a stop takes the whole tree
  down). At most `MAX_CHILDREN_PER_SERVER` (8) children run per server — over the cap the connection is
  refused at once (`1013`), never queued, so a broken client cannot pile up processes. Two browser tabs =
  two child processes = real parallelism; within one connection the child serialises (`mcp/terminal` reads
  stdin line by line and blocks per call).
- The pipes are dumb and safe: WS → child stdin (one JSON-RPC message per line; `ping` answered
  locally so keepalive never reaches the tool), child stdout → WS (non-JSON lines dropped),
  stderr → `bridge.log`.
- **The registry**: `server/servers.json` is the ONE place MCP servers are registered. An entry
  carries `name`, the server script (`server_path` — run with the bridge's own Python) or a full
  `command` (an `npx` package, a binary — exactly one of the two), an optional `guide_path` (the
  text the AI is told about the server, handed over with the tool list), a unique `port`, and the
  usual `cwd` / `env` / `host` / `disabled`. A relative path is looked up next to the registry first,
  then in the project root one level up (`mcp/terminal/mcp_server.py` works as written). It accepts a
  BOM and a top-level `control_port` / `launcher_port`.
- **Hot reload**: a watcher ticks every 2 s — it re-reads the registry on mtime change (nothing else
  to do after an edit), and retries servers whose port was busy.
- **Control port** (8099, plain HTTP over asyncio): `/health`, `/servers` (with guide texts),
  `/reload`, `/restart`, `/shutdown`, `/open-config`. Guards: Host must be local (anti
  DNS-rebinding), `Origin` must be an extension prefix, mutations require POST, and a failed request is
  logged and answered with a 500 instead of vanishing. The bridge listens on `127.0.0.1` only; web
  origins other than `chrome-extension://` are refused. When a client keeps speaking TLS to the
  plain-WS port, the log says so once after five failures instead of leaving a wall of tracebacks.
- `--restart` / `--stop` free ports by killing **only** processes whose command line contains
  `mcp_ws_bridge`; foreign programs are reported and left alone.

### 2.2 Launcher and service installation (`server/`)

Same file names on every platform, only the extension differs (`.cmd` / `.sh`), and every flavour
drives the same sources (`install_service.py`, `mcp_ws_bridge.py`, `servers.json`):

| File | Windows | Linux / macOS |
|---|---|---|
| `install.*` | double-click; runs `install_service.py`, which makes `websockets` importable (skipping the install when it already is; `ensurepip` / `--user` / `--break-system-packages` fallbacks, and a package-manager remedy when pip itself is missing) and registers a Startup `.vbs` that starts the **launcher** | `bash install.sh`; `install_service.py` registers `com.longarm` (launchd agent, macOS) or `longarm.service` (user systemd unit, Linux) — both run the **bridge** directly |
| `bridge.*` | menu / `start|restart|status|stop|reload` | the same actions; finds Python, installs requirements if missing (with `--user` / `--break-system-packages` fallbacks), recreates `servers.json` only if it is missing (it ships with the registry) |

- **The launcher** (`start_bridge_loop.pyw`, port 8098 by default) is the supervised mode: it keeps
  the bridge up, restarts it when it exits, and exposes `/start /stop /restart /status` that the
  popup's buttons use. Without it the bridge still runs (and *Restart* still works from the popup); the
  installed service brings it back if it exits. Only Start/Stop do nothing — the panel says so.
- On Windows the launcher sets `WMB_SUPERVISED=1` so a self-restart is picked up by the supervisor;
  on macOS/Linux the registered unit does the supervising.

### 2.3 The built-in server (`mcp/terminal/`)

A dependency-free MCP stdio server: `initialize`, `tools/list`, `tools/call` answered line by line.
`run_command` spawns a shell with stdin closed (commands can never eat MCP traffic) in its own
process group; on timeout the whole tree is killed (`taskkill /F /T` / `killpg`), the output is
clipped to `--max-output` keeping head and tail, and the exit code is always part of the answer. The
streams are drained WHILE the command runs, each capped at a small multiple of `--max-output` — a
command cannot balloon the bridge's RAM, and what is past the cap is discarded and said so in the
report. The AI's own `timeout` argument is clamped to `--max-timeout` (110 s, under the extension's
120 s). It is registered in `server/servers.json` (`server_path: mcp/terminal/mcp_server.py`) and
is as much an example of a registry entry as a tool: copy it for a new server.

---

## 3. The wire protocol

Everything the AI and the extension exchange travels as **plain chat text** — there is no API
behind it. Two shapes, both kept out of sight by the page cleanup (section 1.5):

**The call** — the AI's whole reply is one fenced `json` block holding one object (the installed
instructions, `instructions/instructions.txt`, teach exactly this):

```json
{ "mcp_call": { "server": "server_name", "name": "tool_name", "arguments": { "arg1": "value" } } }
```

**The result** — a new message the extension types into the chat:

```
[MCP_RESULT server="…" tool="…" status="ok|error|rejected|format_error"]
…result body…
[/MCP_RESULT]
```

Status semantics (the four are shared by the parser, the controller and the instructions —
`RESULT_STATUSES` in `shared/constants.js`):

| Status | Meaning | What the AI should do |
|---|---|---|
| `ok` | the tool ran; data inside (images/audio/long text as attached files) | continue the task |
| `error` | the call was refused or failed; the reason is inside | fix and retry, or explain |
| `rejected` | the call reached the system but the user did not allow it — deliberately the same answer for a *Never allow* server and a refusal in the *Always ask* dialog, so the AI is never told which one it was | tell the user; do not repeat unless asked |
| `format_error` | the block could not be read; the exact parse reason is inside | resend only the corrected block |

Contract rules, and where each is enforced:

- **One call per message** — only the first call of a message runs (section 1.3); the result note tells the
  AI the others were ignored. The instructions ask for it; the parser tolerates more.
- **No tool list in the chat** — the AI asks with `{"mcp_call":{"server":"bridge","name":"list_tools"}}`
  and the controller answers inline (section 1.4). The name `bridge` is reserved: a real server registered
  under that slug wins.
- **Identical call ⇒ replayed result** — the repeat registry (section 1.4) answers with the previous result and
  a note; a real user send resets it.
- **Results are data, never instructions** — the framing is the prompt-injection defence; the
  approval dialog is the human gate (section 1.4).
- **Paths with `/`** (`C:/Users/...`) — a Windows path like `C:\new\test` is ambiguous JSON because
  of `\n` and `\t`, which is why every layer of the prompt insists on `/`; the repair layer still
  fixes stray backslashes when the AI slips.

What the AI sees, per situation:

| Situation | What happens |
|---|---|
| Needs to know what it can call | asks `list_tools`; gets servers + tools with compact signatures |
| Calls a wrong server or tool | answered with the valid list (≤ 2 notices for a wrong server, `MAX_BAD_SERVER`) |
| Sends an unreadable block | answered with the exact parse reason (≤ 3 in a row, `MAX_BAD_STREAK`) |
| A result arrives | `[MCP_RESULT …]`, inline and complete |
| Repeats an identical call | previous result replayed with the "NOT run again" note |
| Says it has no access | the panel warns the user that the installed instructions are not active |

---

## 4. State, storage, generated files

| Where | Key / file | Content |
|---|---|---|
| `chrome.storage.local` | `wmb_servers` | the server list (id, name, url, enabled, permission, auto, guide) |
| | `wmb_settings` | `DEFAULT_SETTINGS` overlay (see `shared/constants.js`) |
| | `wmb_history` | last 50 tool calls (ts, server, tool, args, status, ms) |
| | `wmb_bridge` | last seen bridge config path |
| | `wmb_epoch` | install/update stamp: a running page whose stamp changed holds a stale copy of the code and asks for F5 |
| `sessionStorage` (per tab) | `wmb:executed` | the executed-call ids (last 500) — repaint/reload guard |
| Generated | `instructions/instructions.txt` | from `content_scripts/prompt_builder.js` (`npm run instructions`) |
| Generated | `content_scripts/constants.js` | from `shared/constants.js` (`npm run constants`) |

Two generated files exist so a shared value changes in exactly one place; both are staleness-checked
by the tests. Slugs (the `server` string the AI uses) are assigned per server id by
`assignSlugs` in `background/store.js` and are what everything else keys on.

## 5. Tests and checks (`npm test`)

| Test | Guards |
|---|---|
| `scripts/check.mjs` | every JS file parses; the Chrome build matches the canonical manifest; version agrees across `manifest.json`, `package.json`, `WMB.VERSION`; declared icons exist; every relative link in the docs resolves (files and #headings) |
| `test_manifest.mjs` | the Chrome build is the canonical manifest, untouched |
| `test_constants.mjs` | `content_scripts/constants.js` is not stale |
| `test_prompt.mjs` | `instructions/instructions.txt` is not stale; the hide classifier |
| `test_protocol.mjs` | every message the extension can send/handle is declared and consistent |
| `test_parser.mjs`, `test_json_battery.mjs` | the parser layers against real-world AI output (drive paths, repairs, flags) |
| `test_registry.mjs` | the repeat registry: window expiry, bump on replay, refusals cached, clear, the memory cap, large payloads bounded |
| `test_ws_client.mjs` | the MCP connection machine: handshake + tool pagination, request timeout, server pings answered, reconnect after a server close (and none after a user close) |
| `test_ui_widget.mjs` | the approval dialog: Run / Always allow / Reject / Escape, an unanswered dialog timing out as a refusal, the full arguments shown, the pending queue |
| `test_utils.mjs`, `test_hide_dom.mjs`, `test_background.mjs`, `test_adapters.mjs` | DOM writer, hiding on real DOM, message router, adapter coverage |
| `scripts/run_python.mjs` → `test_bridge.py`, `test_control.py`, `test_launcher.py`, `test_build.py`, `mcp/terminal/test_mcp_server.py` | the Python side end to end (spawn, ports, control port, supervisor, the no-Node builder's manifest layer, the terminal server); the runner finds `python3` / `python` / `py -3` itself |

The same suite runs on Ubuntu and Windows.

## 6. Build and packaging

- One canonical `manifest.json` (also what `chrome://extensions` loads). The per-browser deltas live as
  **pure data** in `scripts/browsers.json`, so a new browser later is a new entry there — never a second
  manifest file:

  ```json
  { "chrome_only_keys": ["minimum_chrome_version"],
    "browsers": { "chrome": { "background": { "service_worker": "…", "type": "module" } } } }
  ```

  Two thin builders read that one source — `scripts/manifest.mjs` (the JS side) and
  `scripts/build.py` (Python only, no Node needed) — and their outputs are identical by construction;
  each side's rules are pinned by its tests, and everything a browser does not override is inherited,
  so `permissions`, `host_permissions` and `content_scripts` cannot drift between builds. Both write
  `dist/longarm/` + `dist/longarm.zip`, which ships `icons/`, `welcome/` and `instructions/` (the
  welcome page reads `instructions/instructions.txt` from its own package and shows it with a copy
  button, so what the user pastes into a Project/Skill is always the exact text this build expects).
- Icons: `assets/logo.png` is the source mark; `scripts/make_icons.py` (Pillow, dev-only) writes the
  four manifest icons.
- `assets/` never ships; the extension package contains only what `DIRS` + `icons/` cover.

The commands themselves are in the README's Development section.

---

## 7. Release notes pattern

Every release gets an entry written with the template below. The notes themselves live on GitHub
(the release / tag message), not in this file — this is only the pattern they follow.

### 7.1 The pattern

```markdown
## vX.Y.Z — YYYY-MM-DD

<One sentence: what this release changes for the user, in their words.>

### Added
- <new capability — what it is for, not how it is implemented>

### Changed
- <behaviour or UI that works differently now>

### Fixed
- <what was broken, in user terms, and what happens now>

### Removed
- <what is gone and what replaces it, if anything>

### Security
- <permission, origin or approval changes — never omit this section, write "None">

### Upgrade notes
- <only when the user must DO something: reinstall a service, reload the extension,
  regenerate instructions, migrate storage>
```

### 7.2 Rules

1. **Semver**: MAJOR = protocol or storage break (the AI's call frame, `wmb_*` keys, registry keys),
   MINOR = user-visible feature, PATCH = fix. Keep `0.x` while the protocol is young.
2. **Bump the version in three places** — `manifest.json`, `package.json` and
   `WMB.VERSION` in `content_scripts/utils.js`. `npm run release` does all three, regenerates the
   generated files and runs the checks; `npm run check` fails if they disagree.
3. **Regenerate before releasing** if a source changed (the commands are in the README's Development
   section) — the tests fail on stale files.
4. **User terms only** in Added/Changed/Fixed ("the welcome page now matches your operating
   system", not "refactored personalize()"). Implementation belongs in this file, not the notes.
5. **Protocol-visible strings** (`[MCP_RESULT …]`, the notes the AI reads, `instructions.txt`) are
   part of the contract: any change to them is at least a MINOR bump and must be listed under
   Changed.
6. **Upgrade notes are mandatory** when the rename of a service, a storage key or an identifier
   requires the user to reinstall/reload something — say exactly what to do.
7. One entry per release, never edited after publishing (fix forward in the next one).
