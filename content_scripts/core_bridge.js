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
  const { tool: TOOL_TIMEOUT_MS, deliver: DELIVER_TIMEOUT_MS, queue: QUEUE_BUDGET_MS, heartbeat: HEARTBEAT_MS } = WMB.defaults.timeouts;
  const { max: MAX_REPEATS } = WMB.defaults.repeat;
  // The ONE semantic repeat-guard: an identical call is answered with the previous result instead of running
  // again (a repeat can repeat a side effect). A real user send and a permission change clear it — see
  // refresh() and noteUserSend.
  const registry = new WMB.CallRegistry();
  // A refusal has TWO truthful forms: before execution (deny / Reject — nothing ran) and mid-flight
  // (permission revoked while the tool ran — it may have started). Both are `rejected`, but the body must
  // not claim "nothing happened" in the second case.
  // Before execution (deny / Reject): nothing ran, and the AI must not retry.
  const NOT_ALLOWED_BEFORE = 'The call reached the system, but the user did not allow it to run, so nothing was run. Do not send it again on your own; tell the user it was not permitted, and call it again only if they ask.';
  // Permission revoked WHILE the tool was running: it may have started (or partially applied). Saying
  // "nothing happened" here would be false and could make the AI repeat a side effect.
  const NOT_ALLOWED_IN_FLIGHT = 'The call reached the system and was already running when the user revoked permission, so it may have started or partially applied. Do not resend it; check the current state (or ask the user) before trying anything again.';
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
  const TAB_ID = WMB.generateUuid(); // this page load: the cross-tab claim only refuses a DIFFERENT tab
  let queue = Promise.resolve();
  let lastRefreshError = '';
  let lastPermissionSig = ''; // the permissions as they were at the last refresh (see refresh)
  let codeEpoch = null;       // the install stamp this copy was born under (a change means: stale copy)
  // Detections being handled right now. The same request id arriving twice (two observers, a repaint racing the
  // scan) must run once — but a LATER identical call is a legitimate repeat, so an entry is dropped when done.
  const inFlight = new Set();

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
   * Delivers results (single or batch) to the chat with NOTHING omitted:
   * text goes inline, images/audio/blobs (and very long texts) as attached files.
   * If there are multiple calls in the batch, each result is wrapped in its own [MCP_RESULT ...] block.
   */
  async function deliverBatch(items, callIds = [], conversation = null, turn = null) {
    if (!items.length) return { ok: true };
    const { autoSend, maxResultChars } = state.settings;

    // The conversation moved on while the calls were running: the results belong to the conversation that asked.
    // Delivering them here would type an answer into a chat that never asked for it.
    if (!adapter.isSameConversation(conversation)) {
      widget.log('err', `${items.length > 1 ? 'Results' : 'Result'} dropped: this page is now in another conversation, so the answer belongs to the one that asked (its own tab has it).`);
      return { ok: false, error: 'another conversation' };
    }
    // ...or the USER started a new turn while the tool ran: the old result would answer the new prompt.
    if (adapter.isSameTurn && !adapter.isSameTurn(turn)) {
      widget.log('err', `${items.length > 1 ? 'Results' : 'Result'} dropped: the user started a new turn, so this answer belongs to the previous one.`);
      return { ok: false, error: 'a new turn' };
    }

    const planned = items.map(({ srv, call, result }, i) => {
      const { status, text, raw, note } = result;
      // In a batch every result gets its own file stem: two screenshots from the same tool would otherwise
      // both be `server_tool_1.png`, and a marker could not say which attachment belongs to which call.
      const plan = WMB.planResult(raw ?? { content: [{ type: 'text', text }] }, {
        server: srv.slug, name: call.name, status, maxChars: maxResultChars,
        serial: items.length > 1 ? i + 1 : 0,
      });
      return { srv, call, result, plan, note };
    });

    const allFiles = planned.flatMap((p) => p.plan.files);
    let attached = true;
    if (allFiles.length) {
      widget.log('ok', `Attaching ${allFiles.length} file(s) to the chat…`);
      attached = await adapter.attachFiles(allFiles);
      if (!attached) {
        for (const file of allFiles.filter((f) => !f.overflow)) {
          try { WMB.dom.download(WMB.dom.fileFrom(file)); } catch { /* noop */ }
        }
        widget.log('err', 'Could not attach to the chat: the file was downloaded (drag it into the chat).');
      }
    }

    const blocks = planned.map(({ plan, note }) => {
      const body = plan.build(attached);
      return note ? `${body}\n${note}` : body;
    });
    const message = blocks.join('\n\n');

    const sent = await adapter.sendToolResult(message, {
      autoSend,
      settleMs: attached && allFiles.length ? 1500 : 0,
      callIds,
      conversation,
      turn,
    });
    const label = planned.length > 1 ? `${planned.length} results` : 'Result';
    widget.log(sent.ok ? 'ok' : 'err', sent.ok ? `${label} sent to ${adapter.name}.` : sent.error);
    return sent;
  }

  /** Backwards-compatible single deliver helper. */
  function deliver(srv, call, result, conversation = null) {
    return deliverBatch([{ srv, call, result }], [], conversation);
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
    if (text.length <= 1500) return text;
    // Never cut a server/tool name in half: stop at the last complete line and say where the rest is.
    const cut = text.slice(0, 1500);
    const at = cut.lastIndexOf('\n');
    return `${cut.slice(0, at > 0 ? at : 1500)}\n… (the list continues: ask the bridge for the full list with {"mcp_call":{"server":"bridge","name":"list_tools"}})`;
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

  /** The tool list text, identical for the single `list_tools` call and for one inside a batch. */
  async function listToolsText() {
    if (!state.settings.bridgeEnabled) {
      // The access CHECK must answer even when the bridge is off: otherwise the AI's test JSON gets no
      // result at all and it cannot tell "disabled" from "not installed".
      const servers = state.servers.map((s) => s.slug).filter(Boolean).join(', ') || 'none';
      return `LongArm is installed and answering, but its bridge is DISABLED in the extension right now, so no tool can run. Ask the user to enable it (the floating panel or the extension popup). Registered servers: ${servers}.`;
    }
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
    return text;
  }

  /** Answers with the current servers and tools: the same delivery plan as any result (long lists attach). */
  async function answerListTools(callIds = [], conversation = null, turn = null) {
    widget.log('ok', 'The AI asked for the tool list: sending it.');
    const text = await listToolsText();
    return guarded(
      deliverBatch([{ srv: { slug: BRIDGE_SERVER }, call: { name: 'list_tools' }, result: { status: 'ok', text, raw: { content: [{ type: 'text', text }] } } }], callIds, conversation, turn),
      DELIVER_TIMEOUT_MS,
      'The chat did not accept the tool list in time.',
    );
  }

  /**
   * Executes a single call: resolves server/tool, checks repeat cache, asks permission,
   * invokes the tool, and returns { srv, call, result, req } or null if ignored.
   */
  async function executeCall(call, index = 0, total = 1, deadline = Infinity, conversation = null) {
    const req = new WMB.RequestLifecycle(call);

    if (isListTools(call)) {
      req.start();
      const text = await listToolsText();
      req.finish({ state: 'completed', stdout: text, exitCode: 0 });
      // Same shape as answerListTools: ONE protocol for a single list_tools and for one inside a batch.
      return { srv: { slug: BRIDGE_SERVER }, call, result: { status: 'ok', text, raw: { content: [{ type: 'text', text }] } }, req };
    }

    const remaining = () => Math.max(0, deadline - Date.now());
    if (remaining() <= 0) {
      req.start().finish({ state: 'timeout', stderr: 'LongArm: the queue time budget was spent before this call could run. Nothing was run. Tell the user and send the remaining calls in a new message.', exitCode: 124 });
      const jsonText = JSON.stringify(req.toJSON(), null, 2);
      return { srv: { slug: BRIDGE_SERVER }, call, result: { status: 'error', text: jsonText, raw: { content: [{ type: 'text', text: jsonText }] }, note: 'LongArm: the queue time budget expired; this call was NOT run.' }, req };
    }

    const { srv, tool } = await resolveCall(call);

    // An echoed frame ("<tool>", "<name>", "example", …) is not a request; the instructions show that frame.
    // A tool that is REALLY named that is still honored (it resolved to `tool`), and a denied server still
    // gets its «user did not allow it» answer below.
    if (!tool && srv?.permission !== 'deny' && isPlaceholder(call.name)) {
      widget.log('err', `Call ignored: placeholder tool «${call.name}».`);
      return null;
    }

    // Every call that NAMES something real gets an answer — never a silent null. An echoed instruction
    // example (placeholder server/tool) is the only silent case: it is not a request.
    const errorResult = (message, resultSrv = { slug: BRIDGE_SERVER }) => {
      req.start().finish({ state: 'failed', stderr: message, exitCode: 1 });
      const jsonText = JSON.stringify(req.toJSON(), null, 2);
      return { srv: resultSrv, call, result: { status: 'error', text: jsonText, raw: { content: [{ type: 'text', text: jsonText }] } }, req };
    };

    // Call matching no active MCP: an echoed example is ignored; a real-looking wrong name is answered.
    if (!srv) {
      const named = Boolean(call.server && !isPlaceholder(call.server));
      if (!named && call.server) {
        widget.log('err', `Call ignored: placeholder server «${call.server}».`);
        return null;
      }
      if (named && !state.tools.length) {
        return errorResult(`No MCP tool is available right now, so nothing was run. Call {"mcp_call":{"server":"bridge","name":"list_tools"}} to see the current servers and tools.`);
      }
      if (named) {
        badServerStreak += 1;
        // The full catalog a couple of times; after that a SHORT error (never silence).
        const full = badServerStreak <= MAX_BAD_SERVER;
        const text = full
          ? `No MCP server named «${call.server}» is active, so nothing was run. Active servers and their tools (use these names exactly):\n${serverCatalog()}`
          : `No MCP server named «${call.server}» is active. Active servers: ${state.servers.map((s) => s.slug).join(', ') || 'none'}. Call {"mcp_call":{"server":"bridge","name":"list_tools"}} for their tools.`;
        widget.log('err', `Server «${call.server}» is not active (${badServerStreak}/${MAX_BAD_SERVER}): answering.`);
        return errorResult(text);
      }
      const names = state.servers.map((s) => s.slug).join(', ');
      return errorResult(`This call does not name a server, and ${state.servers.length ? `several are active (${names})` : 'none is active'}. Name the server exactly (call list_tools if unsure); nothing was run.`);
    }
    badServerStreak = 0;

    // One call, one tab: two tabs showing the same conversation both detect the same request. The service
    // worker hands the execution to the FIRST one; the other gets an explicit answer (never silence, and
    // never a second execution).
    if (tool && srv.permission !== 'deny') {
      const claimKey = WMB.hash(JSON.stringify([conversation ?? adapter.conversationKey(), srv.slug, call.name, call.arguments ?? {}]));
      const claim = await send({ type: 'CLAIM_CALL', key: claimKey, tab_id: TAB_ID });
      if (claim?.ok && claim.fresh === false) {
        widget.log('err', `This call is already running in another tab; not running it here twice.`);
        return errorResult('This exact call is already running in another tab. Do not resend it: wait for its result in the conversation.', srv);
      }
    }

    const repeatKey = registry.key(srv.slug, call.name, call.arguments ?? {});
    const repeats = registry.repeats(repeatKey);
    const cached = registry.lastResult(repeatKey);
    let cachedState = cached?.status ?? null;
    try {
      const parsed = JSON.parse(cached?.raw?.content?.[0]?.text ?? '');
      if (parsed?.status) cachedState = parsed.status;
    } catch { /* not a lifecycle JSON: keep the stored status */ }
    // - allow: an identical call is answered from the previous result (never run twice by accident).
    // - ask: the user must be asked for every RUN, but a previous REFUSAL is replayed (no dialog again).
    // - deny: handled below.
    const dedupEligible = srv.permission === 'allow' || (srv.permission === 'ask' && cachedState === 'cancelled');
    if (repeats >= MAX_REPEATS && tool && dedupEligible) {
      if (repeats >= 3) {
        // Runaway flood: stop running it, but still ANSWER it — a batch must never lose one of its calls.
        req.start().finish({
          state: 'failed',
          stdout: '',
          stderr: 'LongArm: Runaway loop prevented: this identical call was repeated too many times without a new user turn. It was NOT run. Stop repeating it and ask the user for guidance.',
          exitCode: 1,
          cached: false,
        });
        const jsonText = JSON.stringify(req.toJSON(), null, 2);
        widget.log('err', `Suppressed duplicate call ${call.name} (${repeats}×) to break runaway loop.`);
        registry.bump(repeatKey);
        return {
          srv,
          call,
          result: {
            status: 'error',
            text: jsonText,
            raw: { content: [{ type: 'text', text: jsonText }] },
            note: 'LongArm: this call was NOT run: the runaway loop guard stopped it.',
          },
          req,
        };
      }

      if (repeats >= 2) {
        // Second repeat: explicitly halt the loop with a failure notice so the AI stops repeating
        req.start().finish({
          state: 'failed',
          stdout: '',
          stderr: 'LongArm: Runaway loop prevented. This identical call was repeated multiple times in the 15-second loop window without argument changes. Halting tool loop to prevent infinite recursion. Stop repeating and ask the user for guidance or wait 15 seconds.',
          exitCode: 1,
          cached: false,
        });
        const jsonText = JSON.stringify(req.toJSON(), null, 2);
        const haltResult = {
          status: 'error',
          text: jsonText,
          raw: { content: [{ type: 'text', text: jsonText }] },
          note: 'LongArm: Runaway recursion loop halted.',
        };
        widget.log('err', `Runaway recursion loop halted for ${srv.slug} › ${call.name}`);
        registry.bump(repeatKey);
        return { srv, call, result: haltResult, req };
      }

      // First repeat (repeats === 1): serve from cache once with clear cached: true
      req.start();
      let prevPayload = null;
      try {
        if (cached?.raw?.content?.[0]?.text) prevPayload = JSON.parse(cached.raw.content[0].text);
      } catch { /* not json */ }

      const stdout = prevPayload?.result?.stdout ?? cached?.text ?? '';
      const stderr = prevPayload?.result?.stderr ?? '';
      const exitCode = prevPayload?.result?.exit_code ?? 0;
      const prevState = prevPayload?.status ?? (cached?.status === 'ok' ? 'completed' : 'failed');

      req.finish({
        state: prevState,
        stdout,
        stderr: stderr ? `${stderr}\n(LongArm: duplicate call intercepted inside loop window; served from cache)` : '(LongArm: duplicate call intercepted inside loop window; served from cache)',
        exitCode,
        cached: true,
      });
      const jsonText = JSON.stringify(req.toJSON(), null, 2);
      const cachedResult = {
        status: req.state === 'completed' ? 'ok' : (req.state === 'cancelled' ? 'rejected' : 'error'),
        text: jsonText,
        raw: { content: [{ type: 'text', text: jsonText }] },
        note: `LongArm: this call is IDENTICAL to one you already sent within the 15s window: result returned from cache with cached: true.`,
      };
      widget.log('err', `Identical call (${repeats + 1}×): repeating the previous result without running it.`);
      registry.bump(repeatKey);
      return { srv, call, result: cachedResult, req };
    }

    let result;
    if (srv.permission === 'deny') {
      req.start().finish({ state: 'cancelled', stderr: NOT_ALLOWED_BEFORE, exitCode: 126 });
      const jsonText = JSON.stringify(req.toJSON(), null, 2);
      result = { status: 'rejected', text: jsonText, raw: { content: [{ type: 'text', text: jsonText }] } };
      widget.log('err', `Blocked: ${srv.slug} › ${call.name}`);
    } else if (!tool) {
      const available = state.tools.filter((t) => t.server === srv.slug).map((t) => t.name).join(', ');
      const elsewhere = state.tools.filter((t) => t.name === call.name && t.server !== srv.slug).map((t) => t.server);
      const hint = elsewhere.length ? ` The tool «${call.name}» does exist in: ${elsewhere.join(', ')}.` : '';
      const errText = `The tool «${call.name}» does not exist in «${srv.slug}». Available tools: ${available || 'none'}. Use one of those names exactly.${hint}`;
      req.start().finish({ state: 'failed', stderr: errText, exitCode: 1 });
      const jsonText = JSON.stringify(req.toJSON(), null, 2);
      result = { status: 'error', text: jsonText, raw: { content: [{ type: 'text', text: jsonText }] } };
    } else {
      let approved = true;
      if (srv.permission === 'ask') {
        const answer = await widget.requestApproval(
          { server: srv.slug, name: call.name, arguments: call.arguments },
          { timeoutMs: Math.min(WMB.defaults.timeouts.approval, remaining()) },
        );
        approved = Boolean(answer);
        if (answer === 'always') {
          await send({ type: 'SET_PERMISSION', id: srv.id, permission: 'allow' });
          await refresh();
        }
      }

      if (!approved) {
        req.start().finish({ state: 'cancelled', stderr: NOT_ALLOWED_BEFORE, exitCode: 126 });
        const jsonText = JSON.stringify(req.toJSON(), null, 2);
        result = { status: 'rejected', text: jsonText, raw: { content: [{ type: 'text', text: jsonText }] } };
        widget.log('err', `Rejected: ${srv.slug} › ${call.name}`);
      } else {
        const step = total > 1 ? `(${index + 1}/${total}) ` : '';
        widget.log('ok', `${step}Running ${srv.slug} › ${call.name}…`);
        req.start();
        let response;
        try {
          response = await callWithRetry(srv, call, 'The tool took too long to respond (timeout). It may still be running: do not resend the same call right away; check its effect first, or tell the user.', req.id, deadline);
        } catch (err) {
          response = { ok: false, error: err.message };
          // The page stopped waiting (tool timeout / queue budget): stop the server-side work too instead of
          // leaving a shell command running with nobody to answer.
          send({ type: 'CANCEL_TOOL', request_id: req.id }).catch(() => {});
        }

        let runState = 'completed';
        let stdout = '';
        let stderr = '';
        let exitCode = 0;
        let durationMs = null;
        let extraStructured = null; // structuredContent the text does not already carry
        const nonTextContent = [];

        if (!response?.ok) {
          if (response?.rejected) {
            runState = 'cancelled';
            stderr = NOT_ALLOWED_IN_FLIGHT;
            exitCode = 126;
          } else {
            const isTimeout = /timeout|too long/i.test(response?.error ?? '');
            runState = isTimeout ? 'timeout' : 'failed';
            stderr = response?.error ?? 'Unknown error.';
            exitCode = isTimeout ? 124 : 1;
          }
        } else {
          const rawResult = response.result;
          const structured = rawResult?.structuredContent && typeof rawResult.structuredContent === 'object'
            ? rawResult.structuredContent
            : null;
          // Every text item belongs to the server's answer; non-text items (images, audio, resources) must
          // survive whichever branch decides the status.
          const textItems = [];
          for (const item of rawResult?.content ?? []) {
            if (item.type === 'text') textItems.push(item.text ?? '');
            else nonTextContent.push(item);
          }
          const combinedText = textItems.join('\n');
          // The built-in terminal server answers with BOTH a human report (content text: exit code, streams,
          // clipping/timeout notes) and the raw fields in structuredContent. Prefer the report: rebuilding
          // stdout/stderr from the fields silently drops those notes, and a clipped stream then looks complete.
          const terminalShaped = Boolean(structured
            && ['stdout', 'stderr', 'exit_code', 'timed_out', 'duration_ms'].some((key) => key in structured));
          if (terminalShaped) {
            const report = combinedText;
            const coveredStdout = !structured.stdout || Boolean(report && report.includes(structured.stdout));
            const coveredStderr = !structured.stderr || Boolean(report && report.includes(structured.stderr));
            stdout = report || structured.stdout || structured.info || '';
            stderr = coveredStderr ? '' : (structured.stderr ?? '');
            // The report is the full answer unless a custom server put other data in structuredContent.
            if (report && !coveredStdout) extraStructured = structured;
            exitCode = typeof structured.exit_code === 'number' ? structured.exit_code : 0;
            durationMs = structured.duration_ms;
            if (structured.timed_out) {
              runState = 'timeout';
              if (!exitCode) exitCode = 124;
            } else if (exitCode !== 0 || rawResult?.isError) {
              runState = 'failed';
              if (!exitCode) exitCode = 1;
            } else {
              runState = 'completed';
            }
          } else if (structured) {
            // Any other server: content is the result; structuredContent is supplementary and is appended
            // only when the text does not already carry it.
            const structuredText = JSON.stringify(structured, null, 2);
            if (rawResult?.isError) {
              runState = 'failed';
              stderr = combinedText || structuredText;
              exitCode = 1;
              // The text is the error; the structured fields (if they add anything) stay readable in stdout.
              if (combinedText && !combinedText.includes(structuredText)) stdout = structuredText;
            } else {
              stdout = combinedText
                ? (combinedText.includes(structuredText) ? combinedText : `${combinedText}\n\n${structuredText}`)
                : structuredText;
              runState = 'completed';
              exitCode = 0;
            }
          } else if (rawResult?.isError) {
            runState = 'failed';
            stderr = combinedText;
            exitCode = 1;
          } else {
            runState = 'completed';
            stdout = combinedText;
            exitCode = 0;
          }
        }

        req.finish({ state: runState, stdout, stderr, exitCode, durationMs });
        const jsonText = JSON.stringify(req.toJSON(), null, 2);
        result = {
          // `rejected` is a protocol status of its own: the AI must NOT retry a permission refusal as if it
          // were a tool error. Every cancelled path (deny, dialog refusal, revoked permission) maps here.
          status: runState === 'completed' ? 'ok' : (runState === 'cancelled' ? 'rejected' : 'error'),
          text: jsonText,
          raw: {
            content: [{ type: 'text', text: jsonText }, ...nonTextContent],
            ...(extraStructured ? { structuredContent: extraStructured } : {}),
          },
        };
        widget.log(result.status === 'ok' ? 'ok' : 'err', `${step}${call.name}: ${runState} (${result.status})`);
      }
    }
    if (tool && srv.permission !== 'deny') {
      registry.record(repeatKey, result, repeats + 1);
    }
    return { srv, call, result, req };
  }

  /** Handles an MCP call (or batch of calls) detected in the AI response. */
  async function handleCall(detected) {
    if (detected.malformed) {
      // The conversation is the one the detection happened in (captured by the adapter), not whatever is on
      // screen now: an approval waiting in the queue may have let the user switch chats meanwhile.
      return handleMalformed({
        text: detected.text,
        conversation: detected.conversation ?? adapter.conversationIdentity?.() ?? adapter.conversationKey(),
        turn: detected.turn ?? adapter.turnStartedAt,
      });
    }
    badStreak = 0;

    const calls = detected.calls?.length ? detected.calls : (detected.call ? [detected.call] : []);
    if (!calls.length) return;

    // One detection, one execution: the same request id arriving twice (two observers, a repaint racing the scan)
    // is the same request. A later identical call gets a fresh id from the adapter, so this never blocks repeats.
    const detectedId = detected.id ?? detected.ids?.[0] ?? null;
    if (detectedId !== null) {
      if (inFlight.has(detectedId)) return;
      inFlight.add(detectedId);
    }
    // A call that gets no result (ignored, dropped, delivery failed) must not keep its `running` line.
    const dropLines = (call = null) => {
      try { WMB.hide?.dropped?.(detected.element, call); } catch { /* display only: never break the call */ }
    };
    try {
      // The conversation this detection belongs to: every result of this turn is delivered there or nowhere.
      // The adapter captures it at DETECTION time; falling back to the current URL only covers old callers.
      const conversation = detected.conversation ?? adapter.conversationIdentity?.() ?? adapter.conversationKey();
      const turn = detected.turn ?? adapter.turnStartedAt;

      // The bridge's own call, answered before any server is looked up: asking for the tools is always allowed.
      if (calls.length === 1 && isListTools(calls[0])) {
        try { WMB.hide?.running?.(detected.element); } catch { /* display only: never break the call */ }
        let delivered = null;
        try { delivered = await answerListTools(detected.ids ?? [], conversation, turn); }
        finally { if (!delivered?.ok) dropLines(); }
        return;
      }
      if (!state.settings.bridgeEnabled) return; // bridge off: real calls are ignored
      try { WMB.hide?.running?.(detected.element); } catch { /* display only: never break the call */ }

      const total = calls.length;
      const deadline = Date.now() + QUEUE_BUDGET_MS; // approvals + reconnects + tools for the WHOLE batch
      const executed = [];
      for (let i = 0; i < total; i += 1) {
        const item = await executeCall(calls[i], i, total, deadline, conversation);
        if (item) executed.push(item);
        else dropLines(calls[i]); // a placeholder, or the queue budget: this call gets no result
      }

      if (!executed.length) return;

      if (detected.extra > 0 && executed.length === 1) {
        executed[0].result.note = `LongArm: only the first call was run; ${detected.extra} more were ignored.`;
      }

      const delivered = await guarded(deliverBatch(executed, detected.ids ?? [], conversation, turn), DELIVER_TIMEOUT_MS, 'The chat did not accept the results in time.');
      if (!delivered?.ok) dropLines();
      // A readable call next to an unreadable block: the run results went out above and the broken block gets
      // its `format_error` too, so nobody is left waiting for an answer that silently vanished.
      if (detected.badText && !detected.malformed) {
        await handleMalformed({ text: detected.badText, conversation, turn });
      }
    } catch (error) {
      dropLines(); // an unexpected failure: every line of this message is stale now
      throw error;
    } finally {
      if (detectedId !== null) inFlight.delete(detectedId);
    }
  }

  // ------------- Invalid format and reconnect -------------

  let badStreak = 0;
  const MAX_BAD_STREAK = 3;
  const CONN_ERR = /not connected|disconnected/i;

  /** The AI sent an unreadable mcp_call: the exact reason is returned so it can fix it (max 3 notices in a row). */
  async function handleMalformed({ text, conversation = null, turn = null }) {
    if (!state.settings.bridgeEnabled || !state.tools.length) return;
    badStreak += 1;
    if (badStreak > MAX_BAD_STREAK) {
      widget.log('err', 'The AI keeps sending an invalid format: I stop warning it. Check the chat.');
      return;
    }
    widget.log('err', `Unreadable call (${badStreak}/${MAX_BAD_STREAK}): warning the AI with the reason.`);
    const sent = await adapter.sendToolResult(WMB.formatCallError(text), { autoSend: state.settings.autoSend, conversation, turn });
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
  async function callWithRetry(srv, call, timeoutMessage, requestId = null, deadline = Infinity) {
    let response;
    const budget = () => Math.max(1000, Math.min(TOOL_TIMEOUT_MS, deadline - Date.now()));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await guarded(send({ type: 'CALL_TOOL', server: srv.slug, name: call.name, arguments: call.arguments, request_id: requestId }), budget(), timeoutMessage);
      if (response?.ok || !CONN_ERR.test(response?.error ?? '') || attempt === 2) break;
      if (deadline - Date.now() < 2000) break; // the queue budget is gone: do not start another reconnect wait
      widget.log('err', `${srv.slug} disconnected: waiting for the reconnect and retrying (${attempt + 1}/2).`);
      await send({ type: 'RECONNECT', id: srv.id });
      await waitConnected(srv, Math.min(40_000, Math.max(0, deadline - Date.now())));
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

  function noteUserSend(event, { regenerate = false } = {}) {
    if (!event.isTrusted) return;
    // A regenerate starts a live turn but does NOT send what is in the composer: a staged result must
    // never be marked delivered because of it.
    adapter.markActivity({ trustedSend: !regenerate });
    registry.clear();
    badServerStreak = 0;
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const composer = adapter.getComposer();
    const isComposer = (composer && (composer === e.target || composer.contains(e.target)))
      || Boolean(e.target?.closest?.('#prompt-textarea, [contenteditable="true"], form textarea, textarea'));
    if (isComposer) noteUserSend(e);
  }, true);

  window.addEventListener('click', (e) => {
    if (!(e.target instanceof Node)) return;
    const isRegenerate = Boolean(e.target.closest?.('button[data-testid*="regenerate"], button[aria-label*="Regenerate" i], button[aria-label*="تولید مجدد" i], button[aria-label*="دوباره" i]'));
    if (isRegenerate) { noteUserSend(e, { regenerate: true }); return; }
    const button = adapter.getSendButton();
    const isSendButton = Boolean(
      (button && button.contains(e.target)) ||
      e.target.closest?.('button[data-testid*="send"], button[aria-label*="Send" i], button[aria-label*="ارسال" i], form button[type="submit"], [data-testid="send-button"]')
    );
    if (isSendButton) noteUserSend(e);
  }, true);

  // Reliable user turn detection: whenever user messages appear in DOM, clear repeat registry.
  // IMPORTANT: a user bubble appearing is NOT a send — opening a chat or re-rendering its history renders one per
  // earlier turn. It only counts as activity (and clears the repeat window); arming a turn is reserved for the
  // trusted keydown/click path below and for live generation, or every rehydrated conversation would run its calls.
  const USER_SELECTORS = [
    '[data-message-author-role="user"]',
    '[data-turn="user"]',
    '[data-testid="user-message"]',
    'article[data-turn="user"]',
    'div[data-message-author-role="user"]',
    '[data-testid*="user"]',
    '.font-user-message',
    'user-query',
  ].join(',');

  try {
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      const userTurnObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) {
              if (node.matches?.(USER_SELECTORS) || node.querySelector?.(USER_SELECTORS)) {
                registry.clear();
                badServerStreak = 0;
                adapter.noteActivity(); // activity only: the adapter arms a turn on a real send or live generation
                return;
              }
            }
          }
        }
      });
      userTurnObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
  } catch { /* ignored in environments without full DOM */ }

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