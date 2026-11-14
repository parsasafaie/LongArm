# Security Policy

LongArm connects web chats (ChatGPT, Gemini, Claude, DeepSeek) with MCP servers running on your own computer. Because it can trigger tools with access to local files and programs, we take security reports seriously and appreciate responsible disclosure.

## Supported versions

Security fixes are provided for the latest release only.

| Version | Supported |
|---------|-----------|
| 0.0.1   | Yes       |
| older   | No        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report it privately to whoever maintains your copy of this project: use the private reporting form
(*Security* tab, *Report a vulnerability*) of the repository you obtained it from, or a private message
channel you already share with them. If neither exists, open an issue that asks for a private contact
without describing the problem itself.

Please include, as far as you can:

- A description of the issue and its impact.
- Steps to reproduce (or a proof of concept).
- Affected version, operating system and browser.
- Any suggested fix or mitigation.

### What to expect

| Stage | Target time |
|-------|-------------|
| Acknowledgement of your report | within 72 hours |
| Initial assessment and severity | within 7 days |
| Fix or mitigation plan | within 30 days for confirmed issues |

We will keep you informed, credit you in the release notes if you wish, and coordinate a disclosure date with you. Please give us a reasonable time to release a fix before any public disclosure.

## Scope

In scope (examples):

- A website being able to reach the bridge, the control port (`:8099`) or the launcher port (`:8098`), bypassing `Origin` / `Host` checks.
- Bypassing the permission system ("Always ask", "Always allow", "Never allow").
- Execution of tools without user approval.
- Prompt-injection paths that escape the `MCP_RESULT` data framing.
- Path traversal or command injection in the Python bridge or launcher.
- Unsafe use of `eval`, `innerHTML` with page data, or unexpected external network requests in the extension.

Out of scope:

- Actions performed by an MCP server that the user chose to register and approve (the server's own behavior is its author's responsibility).
- Attacks requiring prior full control of the user's machine or browser profile.
- Social engineering of the user, and issues in third-party sites (ChatGPT, Gemini, Claude, DeepSeek) themselves.
- Selector breakage after a site redesign.

## The security model

| Risk | Mitigation |
|---|---|
| A website opens `ws://localhost` and runs your tools | The bridge rejects any request whose `Origin` is a web page — only browser extensions pass. |
| The AI runs unwanted actions | *Always ask* is the default; *Always allow* is an explicit choice per server or globally, and *Never allow* blocks one completely (its tools are not even described to the AI). |
| Hidden instructions inside results (prompt injection) | Results are framed as `[MCP_RESULT …]` data only, and every call is shown to you before it runs when the permission is *Always ask*. |
| Network exposure | The bridge listens on `127.0.0.1` only, and the extension refuses any server address that is not local (`localhost` / `127.0.0.1` / `::1`). |
| A website reads or shuts down the control (`8099`) or launcher (`8098`) ports | They reject any web-page `Origin` and any non-local host, state-changing routes require `POST`, and `--restart` only closes real bridge processes. |
| A broken client piles up processes | Each server has a cap on concurrent MCP child processes; over the cap connections are refused, never queued. |
| A wrong click approves a call you did not read | The approval dialog shows the call's arguments IN FULL (a pathological payload is capped with an honest count of what was not shown), and Enter alone never approves. |

In one line:

- The bridge listens on `127.0.0.1` only. A request that carries an `Origin` header is accepted only from a browser extension (`chrome-extension://`); clients that send no `Origin` at all (command-line tools on the same machine) are also accepted.
- The control and launcher ports accept only local hosts and apply the same Origin rule; state-changing routes require `POST`.
- Every tool call requires approval by default.
- Every server address the extension accepts points at this machine.
- Tool results are presented to the AI as data, not instructions.

## Safe usage recommendations

- Only connect MCP servers you trust, and review what each one runs: the `server_path` script (or the `command`) of every entry registered in `server/servers.json`.
- Restrict filesystem MCP servers to the narrowest folder possible.
- Prefer "Always ask" over "Always allow" for tools that write, delete or execute.
- Keep the project and your browser up to date.
