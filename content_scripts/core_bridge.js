/**
 * core_bridge.js — Main controller in each chat tab.
 *
 * The extension NEVER writes instructions into a conversation. The rules live in a Project / Skill the
 * user installed once (`instructions/`), and the AI asks for the tools at run time with the bridge's own `list_tools`
 * call. What this controller does:
 *
 *   1. Detects the platform (adapter) and asks the background for the active MCPs.
 *   2. Shows the floating panel: the state of each MCP and its permission (allow / ask / deny).
 *   3. Watches the AI responses; on detecting a new `mcp_call`:
 *        permission → run via background → deliver the FULL result to the chat (text inline; images, audio and
 *        long texts as attached files) → check that the chat accepted it.
 *   4. Answers `bridge.list_tools` with the current servers and tools, and a wrong server or tool name with the
 *        valid list, so the AI recovers on its own even though nothing is injected into the chat.
 *      Those answers are the only messages the extension types: the page can hide them (`hide.js`).
 *
 * Robustness with the tab in the background: no step depends on the page's setTimeout/setInterval
 * (WMB.sleep is used, which the service worker counts), there is a heartbeat that refreshes the state and a watchdog
 * that stops a stuck call from blocking the queue.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB) return;

  /**
   * The build of the scripts that are running in THIS page: a hash of the installable text, so it changes
   * whenever the text the user installs changes.
   */
  const BUILD = typeof WMB.buildSignature === 'function' ? `${WMB.VERSION}-${WMB.buildSignature()}` : WMB.VERSION;

  /**
   * A tab that was already running the scripts keeps its old copy after the extension is reloaded — the scripts
   * are reinjected, but the old instance owns the page — so it would keep working with the old protocol. When
   * the new copy finds a different build already running, it asks for a page reload instead of starting a
   * second instance (two widgets and two answers to every call would be worse than a stale one).
   */
  if (WMB.contentBuild && WMB.contentBuild !== BUILD) {
    try {
      const box = document.createElement('div');
      box.textContent = 'LongArm: the extension was reloaded, and this page still runs the previous build. Reload the page (F5) to use the new one.';
      box.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;cursor:pointer;'
        + 'background:#18181b;color:#fafafa;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;'
        + 'padding:8px 12px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.28);max-width:80vw;text-align:center;';
      box.title = `Running build ${WMB.contentBuild}, current build ${BUILD}`;
      box.addEventListener('click', () => box.remove());
      document.documentElement.append(box);
    } catch { /* nothing else to do */ }
    return;
  }
  WMB.contentBuild = BUILD;
  if (WMB.started) return;
  const adapter = WMB.findAdapter(location.hostname);
  if (!adapter) return;
  WMB.started = true;

  const MAX_BAD_SERVER = 2;           // recovery notices for wrong server names before going quiet
  // Every wait and window lives in shared/constants.js (content_scripts/constants.js carries it into the page):
  // `tool` is longer than the background's own deadline on purpose, and the repeat window is what makes an
  // identical call answer from the previous result instead of running twice.
  const { tool: TOOL_TIMEOUT_MS, deliver: DELIVER_TIMEOUT_MS, heartbeat: HEARTBEAT_MS } = WMB.defaults.timeouts;
  const { max: MAX_REPEATS } = WMB.defaults.repeat;
  // The ONE semantic repeat-guard: an identical call is answered with the previous result instead of running
  // again (a repeat can repeat a side effect). A real user send and a permission change clear it — see
  // refresh() and noteUserSend.
  const registry = new WMB.CallRegistry();
  // The ONE answer for a call the user did not allow — permission «deny», a refusal in the approval dialog
  // («ask»), or the permission turned to «deny» while the call was in flight (the background flags that case
  // with `rejected`): the AI learns that the call ARRIVED and that the user did not permit it, so it can tell
  // the user and move on instead of retrying or blaming the tool. Never which of those it was.
  const NOT_ALLOWED = 'The call reached the system, but the user did not allow it to run, so nothing happened. Do not send it again on your own; tell the user it was not permitted, and call it again if they ask.';
  // The AI says it has no local access (or that the tools are unavailable "in this session"): a sign that it lost
  // the instructions or refused them. Any language counts — the chat's language does not change what runs here.
  const DENIAL = new RegExp([
    // English
    'i (don\'?t|do not) have (access|tools|the ability)', 'i (can\'?t|cannot|am unable to) (access|control|run|execute|see your)',
    'tools? (are|is|were) (not |un)?(available|accessible|enabled)', 'not available in this session',
    '(can\'?t|cannot) (run|execute) (code|commands|tools|scripts)', 'i (don\'?t|do not) have (the )?(ability|capability) to (run|execute|access|control)',
    // Spanish
    'no tengo acceso', 'no puedo acceder', 'no tengo (la )?capacidad de (acceder|ejecutar|controlar)', 'no puedo (ejecutar|controlar|ver tu|abrir)',
    'no dispongo de (acceso|herramientas)', 'no tengo herramientas',
    // Persian (ZWNJ and the colloquial "نمی‌تونم" included)
    'دسترسی (به [^.]{0,20})?(ندارم|ندارید|ندارد)', 'ابزار[^.]{0,50}در دسترس (اجرا )?(نیست|نمی)',
    'امکان (اجرا|دسترسی)[^.]{0,15}(ندارم|ندارد|نیست)', 'نمی[\\s\\u200c]?(توانم|تونم|توان)[^.]{0,15}(اجرا|دستور|ابزار|کد|کنترل)',
  ].join('|'), 'i');

  const slugKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const guarded = (promise, ms, message) => Promise.race([promise, WMB.sleep(ms).then(() => { throw new Error(message); })]);

  const state = { servers: [], tools: [], guides: {}, settings: { ...WMB.defaults.settings } };
  let queue = Promise.resolve();
  let lastRefreshError = '';
  let lastPermissionSig = ''; // the permissions as they were at the last refresh (see refresh)
  let codeEpoch = null;       // the install stamp this copy was born under (a change means: stale copy)

  // Best-effort: a held Web Lock makes it less likely that the browser freezes the tab in the background.
  try { navigator.locks?.request('wmb-alive', () => new Promise(() => {})).catch(() => {}); } catch { /* noop */ }

  /** Safe messaging: if the extension reloads, the context becomes invalidated. */
  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      return { ok: false, error: /context invalidated/i.test(err.message) ? 'The extension was updated: reload the tab.' : err.message };
    }
  }

  const widget = new WMB.Widget({
    onRefresh: () => { adapter.rescan(); return refresh(true); },
    onToggleBridge: async (value) => {
      await send({ type: 'UPDATE_SETTINGS', settings: { bridgeEnabled: value } });
      await refresh();
    },
    /** `id` = one MCP; `null` = all MCPs at once. */
    onSetPermission: async (id, permission) => {
      await send(id ? { type: 'SET_PERMISSION', id, permission } : { type: 'SET_ALL_PERMISSIONS', permission });
      await refresh();
    },
  });

  // Adapters can write debug messages into the floating panel (e.g. ChatGPT).
  adapter.debug = (kind, message) => widget.log(kind, message);
  // And the page cleanup reports results it could not hide — the user would be looking at bridge text.
  if (WMB.hide) WMB.hide.reporter = (message) => widget.log('err', message);

  async function refresh(announce = false) {
    const [snapshot, active] = await Promise.all([send({ type: 'GET_STATE' }), send({ type: 'GET_ACTIVE_TOOLS' })]);
    if (!snapshot?.ok || !active?.ok) {
      const error = snapshot?.error || active?.error || 'Could not reach the extension.';
      if (error !== lastRefreshError) widget.log('err', error); // the heartbeat does not repeat the same error
      lastRefreshError = error;
      return;
    }
    lastRefreshError = '';
    state.settings = snapshot.settings;
    // The extension was reloaded while this page kept an old copy: the copy keeps running its previous code
    // (the build signature only covers the TEXT, not the code). Say it once, loudly: F5 is the remedy.
    if (typeof snapshot.epoch === 'number') {
      if (codeEpoch === null) codeEpoch = snapshot.epoch;
      else if (snapshot.epoch !== codeEpoch) {
        codeEpoch = snapshot.epoch;
        widget.log('err', 'The extension was updated: this page still runs the previous copy — reload the page (F5).');
      }
    }
    // The page cleanup follows the setting (and puts everything back when it is turned off).
    WMB.hide?.configure(state.settings.hideProtocol);
    state.servers = snapshot.servers.filter((s) => s.enabled && s.url);
    // A permission changed (the dialog's «Always allow», the panel, the popup): the repeat registry starts
    // over, or an AI retrying a call it was refused would keep getting the old refusal after the user allowed it.
    const permissionSig = state.servers.map((s) => `${s.id}:${s.permission}`).join('|');
    if (permissionSig !== lastPermissionSig) {
      registry.clear();
      lastPermissionSig = permissionSig;
    }
    state.tools = active.tools;
    state.guides = active.guides ?? {};   // server slug → its guide.txt, written for the AI
    WMB.tools = state.tools; // the lenient parser uses the schemas
    adapter.configure({ focusFallback: state.settings.focusFallback !== false });
    widget.update({
      adapterName: adapter.name,
      servers: state.servers,
      toolCount: state.tools.length,
      bridgeEnabled: state.settings.bridgeEnabled,
    });
    if (announce) widget.log('ok', `Refreshed: ${state.tools.length} active tools.`);
  }

  /**
   * Delivers the result to the chat with NOTHING omitted: text goes inline and images/audio/blobs
   * (and very long texts) as attached files. If the chat does not accept the attachment, it is downloaded.
   * Nothing is added to it: the rules come from the installed instructions, so no reminder rides along.
   */
  async function deliver(srv, call, { status, text, raw, note }) {
    const { autoSend, maxResultChars } = state.settings;
    const plan = WMB.planResult(raw ?? { content: [{ type: 'text', text }] }, { server: srv.slug, name: call.name, status, maxChars: maxResultChars });

    let attached = true;
    if (plan.files.length) {
      widget.log('ok', `Attaching ${plan.files.length} file(s) to the chat…`);
      attached = await adapter.attachFiles(plan.files);
      if (!attached) {
        for (const file of plan.files.filter((f) => !f.overflow)) {
          try { WMB.dom.download(WMB.dom.fileFrom(file)); } catch { /* noop */ }
        }
        widget.log('err', 'Could not attach to the chat: the file was downloaded (drag it into the chat).');
      }
    }
    const sent = await adapter.sendToolResult(`${plan.build(attached)}${note ? `\n${note}` : ''}`, { autoSend, settleMs: attached && plan.files.length ? 1500 : 0 });
    widget.log(sent.ok ? 'ok' : 'err', sent.ok ? `Result sent to ${adapter.name}.` : sent.error);
  }

  /** Finds the MCP and the tool of a call; if the local state might be stale, it refreshes it once. */
  async function resolveCall(call) {
    const find = () => {
      const wanted = slugKey(call.server);
      const srv = call.server
        ? state.servers.find((s) => s.slug === call.server || slugKey(s.slug) === wanted || slugKey(s.name) === wanted)
        : (state.servers.length === 1 ? state.servers[0] : null);
      return { srv, tool: srv ? state.tools.find((t) => t.name === call.name && t.server === srv.slug) : null };
    };
    let found = find();
    if (!found.srv || (!found.tool && found.srv.permission !== 'deny')) {
      await refresh();
      found = find();
    }
    return found;
  }

  // ------------- Calls with a wrong server name (self-healing) -------------
  // The AI can lose the tool list (long conversations, compressed context). A name that looks real is answered
  // with the list of active servers and their tools instead of being dropped silently, so the AI recovers on
  // its own. Placeholders echoed from the instructions (e.g. "<server>") are ignored: they must not start a round-trip.
  let badServerStreak = 0;
  const PLACEHOLDER = /^(?:[.\u2026]+|server|tool|name|tool_?name|server_?name|slug|value|arg|argument|xx+|abc|foo|bar|example|placeholder|todo|tbd)$/i;
  const isPlaceholder = (value) => {
    const clean = String(value ?? '').replace(/[<>«»"'`\s]/g, '');
    return clean === '' || PLACEHOLDER.test(clean);
  };

  /** Active servers and their tool names, so the AI can fix a wrong server name by itself. */
  function serverCatalog() {
    const lines = state.servers.map((s) => {
      const names = state.tools.filter((t) => t.server === s.slug).map((t) => t.name);
      return `- \`${s.slug}\`${s.name && s.name !== s.slug ? ` (${s.name})` : ''}: ${names.join(', ') || 'no tools'}`;
    });
    const text = lines.join('\n');
    return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
  }

  // ------------- The bridge's own call: `bridge.list_tools` -------------
  // The AI asking the bridge for the list instead of reading it from the chat. It is the normal path when the
  // rules live outside the chat (a Project/Skill: nothing is injected at all) and a way back for a model that
  // lost the list. Nothing is run, no permission is involved, and the answer is never cached: servers come and go.
  const BRIDGE_SERVER = 'bridge';
  const LIST_TOOLS_NAMES = new Set(['list_tools', 'listtools', 'tools', 'list']); // the spellings a model may use
  const isListTools = (call) => slugKey(call.server) === BRIDGE_SERVER
    && LIST_TOOLS_NAMES.has(slugKey(call.name))
    && !state.servers.some((s) => s.slug === BRIDGE_SERVER); // a real server by that name wins

  /** Answers with the current servers and tools, signatures included, inline and in full (no attachment). */
  async function answerListTools() {
    widget.log('ok', 'The AI asked for the tool list: sending it.');
    // The answer must never be a stale empty list: if we have servers but no tools yet (the service worker
    // just restarted, the server is still connecting), take one fresh look before answering.
    if (!state.tools.length && state.servers.length) await refresh();
    let text = `LongArm — the servers and tools of this chat right now (use these names exactly):\n\n${WMB.toolsListText(state.tools, state.guides)}`;
    if (!state.tools.length && state.servers.length) {
      // Still nothing: say WHY instead of pretending no server exists — that line used to send the AI
      // chasing a registration problem that was really a connection one.
      const states = state.servers.map((s) => `- ${s.slug}: ${s.status}${s.error ? ` — ${s.error}` : ''}`).join('\n');
      text += `\n\nThe servers are registered but none is ready yet. Their state right now:\n${states}\nAsk for this list again in a few seconds; if a server stays disconnected, the user should look at server/bridge.log.`;
    }
    const sent = await guarded(
      adapter.sendToolResult(WMB.formatToolResult({ server: BRIDGE_SERVER, name: 'list_tools', status: 'ok', text }), { autoSend: state.settings.autoSend }),
      DELIVER_TIMEOUT_MS,
      'The chat did not accept the tool list in time.',
    );
    widget.log(sent.ok ? 'ok' : 'err', sent.ok ? 'Tool list sent to the chat.' : sent.error);
  }

  /** Handles an MCP call detected in the AI response. */
  async function handleCall(detected) {
    if (detected.malformed) return handleMalformed(detected);
    badStreak = 0;
    const { call } = detected;
    if (!state.settings.bridgeEnabled) return; // bridge off: calls are ignored

    // The bridge's own call, answered before any server is looked up: asking for the tools is always allowed.
    if (isListTools(call)) {
      await answerListTools();
      return;
    }

    const { srv, tool } = await resolveCall(call);

    // Call matching no active MCP: an echoed example is ignored, a real-looking wrong name is answered with the list.
    if (!srv) {
      if (call.server && !isPlaceholder(call.server) && state.tools.length && badServerStreak < MAX_BAD_SERVER) {
        badServerStreak += 1;
        widget.log('err', `Server «${call.server}» is not active (${badServerStreak}/${MAX_BAD_SERVER}): answering with the active servers.`);
        const text = `No MCP server named «${call.server}» is active, so nothing was run. Active servers and their tools (use these names exactly):\n${serverCatalog()}`;
        const sent = await guarded(adapter.sendToolResult(WMB.formatToolResult({ server: BRIDGE_SERVER, name: call.name, status: 'error', text }), { autoSend: state.settings.autoSend }), DELIVER_TIMEOUT_MS, 'The chat did not accept the recovery notice in time.');
        if (!sent.ok) widget.log('err', sent.error);
      } else {
        widget.log('err', `Call ignored: server «${call.server ?? '?'}» is not active.`);
      }
      return;
    }
    badServerStreak = 0;

    const repeatKey = registry.key(srv.slug, call.name, call.arguments ?? {});
    const repeats = registry.repeats(repeatKey);
    if (repeats >= MAX_REPEATS && tool && srv.permission !== 'deny') {
      const cached = { ...registry.lastResult(repeatKey), note: `LongArm: this call is IDENTICAL to one you already sent: it was NOT run again, so nothing new happened on the computer. The result below is the one you already have — use it. If you need fresh data, change something in the call (or ask the user); do not just repeat it.` };
      widget.log('err', `Identical call (${repeats + 1}×): repeating the previous result without running it.`);
      registry.bump(repeatKey);
      await guarded(deliver(srv, call, cached), DELIVER_TIMEOUT_MS, 'The chat did not accept the result in time.');
      return;
    }

    let result;
    if (srv.permission === 'deny') {
      result = { status: 'rejected', text: NOT_ALLOWED };
      widget.log('err', `Blocked: ${srv.slug} › ${call.name}`);
    } else if (!tool) {
      const available = state.tools.filter((t) => t.server === srv.slug).map((t) => t.name).join(', ');
      const elsewhere = state.tools.filter((t) => t.name === call.name && t.server !== srv.slug).map((t) => t.server);
      const hint = elsewhere.length ? ` The tool «${call.name}» does exist in: ${elsewhere.join(', ')}.` : '';
      result = { status: 'error', text: `The tool «${call.name}» does not exist in «${srv.slug}». Available tools: ${available || 'none'}. Use one of those names exactly.${hint}` };
    } else {
      let approved = true;
      if (srv.permission === 'ask') {
        const answer = await widget.requestApproval({ server: srv.slug, name: call.name, arguments: call.arguments });
        approved = Boolean(answer);
        if (answer === 'always') {
          await send({ type: 'SET_PERMISSION', id: srv.id, permission: 'allow' });
          await refresh();
        }
      } // 'allow': always run, never ask

      if (!approved) {
        result = { status: 'rejected', text: NOT_ALLOWED };
        widget.log('err', `Rejected: ${srv.slug} › ${call.name}`);
      } else {
        widget.log('ok', `Running ${srv.slug} › ${call.name}…`);
        let response;
        try {
          response = await callWithRetry(srv, call, 'The tool took too long to respond (timeout). It may still be running: do not resend the same call right away; check its effect first, or tell the user.');
        } catch (err) {
          response = { ok: false, error: err.message };
        }
        if (!response?.ok) {
          // The background said «the user does not allow it» (the permission changed mid-call): same answer the
          // dialog gives, so the AI never sees two different stories for one refusal.
          result = response?.rejected
            ? { status: 'rejected', text: NOT_ALLOWED }
            : { status: 'error', text: response?.error ?? 'Unknown error.' };
        } else result = { status: response.result?.isError ? 'error' : 'ok', raw: response.result };
        widget.log(result.status === 'ok' ? 'ok' : 'err', `${call.name}: ${result.status}`);
      }
    }
    if (tool && srv.permission !== 'deny') {
      // Cached so that a second identical call is answered with this result instead of running anything again.
      // A refusal is cached too: a model that resends the call it was refused gets the same «not permitted»
      // answer instead of opening the approval dialog again — and a retry the user actually asked for follows a
      // message of the user's own, which clears the registry (noteUserSend).
      registry.record(repeatKey, result, repeats + 1);
    }
    if (detected.extra > 0) result.note = `LongArm: only the first call was run; ${detected.extra} more were ignored. Send ONE call per message and wait for the result.`;
    await guarded(deliver(srv, call, result), DELIVER_TIMEOUT_MS, 'The chat did not accept the result in time.');
  }

  // ------------- Invalid format and reconnect -------------

  let badStreak = 0;
  const MAX_BAD_STREAK = 3;
  const CONN_ERR = /not connected|disconnected/i;

  /** The AI sent an unreadable mcp_call: the exact reason is returned so it can fix it (max 3 notices in a row). */
  async function handleMalformed({ text }) {
    if (!state.settings.bridgeEnabled || !state.tools.length) return;
    badStreak += 1;
    if (badStreak > MAX_BAD_STREAK) {
      widget.log('err', 'The AI keeps sending an invalid format: I stop warning it. Check the chat.');
      return;
    }
    widget.log('err', `Unreadable call (${badStreak}/${MAX_BAD_STREAK}): warning the AI with the reason.`);
    const sent = await adapter.sendToolResult(WMB.formatCallError(text), { autoSend: state.settings.autoSend });
    if (!sent.ok) widget.log('err', sent.error);
  }

  async function waitConnected(srv, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const snap = await send({ type: 'GET_STATE' });
      if (snap?.servers?.find((s) => s.id === srv.id)?.status === 'connected') return true;
      await WMB.sleep(2000);
    }
    return false;
  }

  /** Runs the tool; if the server was down BEFORE sending, waits for the reconnect and retries (without duplicating anything). */
  async function callWithRetry(srv, call, timeoutMessage) {
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await guarded(send({ type: 'CALL_TOOL', server: srv.slug, name: call.name, arguments: call.arguments }), TOOL_TIMEOUT_MS, timeoutMessage);
      if (response?.ok || !CONN_ERR.test(response?.error ?? '') || attempt === 2) break;
      widget.log('err', `${srv.slug} disconnected: waiting for the reconnect and retrying (${attempt + 1}/2).`);
      await send({ type: 'RECONNECT', id: srv.id });
      await waitConnected(srv, 40_000);
    }
    return response;
  }

  /** Never lets a failure or a stuck call block the next ones. */
  async function processCall(detected) {
    try {
      await handleCall(detected);
    } catch (err) {
      widget.log('err', `Error: ${err.message}`);
    }
  }

  // ───────────── Noticing the user's own sends ─────────────
  // The extension adds NOTHING to a message any more, but it still wants to know when the user sends one: the
  // repeat count of a call is reset (a new request may legitimately re-run something), a recovery notice may be
  // sent again, and the adapters use the activity to tell a live turn from an old, reloaded page.
  // Only real user events are acted on (isTrusted): never the synthetic ones the extension dispatches itself.

  function noteUserSend(event) {
    if (!event.isTrusted) return;
    adapter.markActivity();
    registry.clear();
    badServerStreak = 0;
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const composer = adapter.getComposer();
    if (composer && (composer === e.target || composer.contains(e.target))) noteUserSend(e);
  }, true);

  window.addEventListener('click', (e) => {
    const button = adapter.getSendButton();
    if (button && e.target instanceof Node && button.contains(e.target)) noteUserSend(e);
  }, true);

  // Changes in the active MCPs (connection, tools, permissions, settings…)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'STATE_CHANGED') refresh();
  });

  // On returning to the tab or regaining focus: state up to date at once.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', () => refresh());

  // Heartbeat: the state never goes stale or stuck even if the tab has been in the background for hours.
  (async () => {
    while (WMB.extensionAlive()) {
      await WMB.sleep(HEARTBEAT_MS);
      try { await refresh(); } catch { /* the next heartbeat retries it */ }
    }
  })();

  refresh().then(() => {
    adapter.observeResponses(
      (detected) => {
        // Processed in series so results are not mixed up.
        queue = queue.then(() => processCall(detected));
      },
      {
        onDone: ({ text }) => {
          if (state.settings.bridgeEnabled && state.tools.length && text.length < 1500 && DENIAL.test(text)) {
            widget.log('err', 'The AI says it has no access: check that the Project/Skill with the LongArm instructions is installed and active in this chat.');
          }
        },
      },
    );
  });
})();