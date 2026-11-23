// Tests for the service worker (discovery, permissions, defaults) with the Chrome API mocked.
import assert from 'node:assert/strict';

// ───────── chrome.* and WebSocket mocks ─────────
const store = {};
const sessionStore = { wmb_claims: { 'persisted-request': { tab: 'tab-old', exp: Date.now() + 60_000 } } };
const focusLog = [];
let onMessage;
let installed;
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (obj) => { Object.assign(store, structuredClone(obj)); },
      remove: async (key) => { delete store[key]; },
    },
    session: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in sessionStore).map((k) => [k, structuredClone(sessionStore[k])])),
      set: async (obj) => { Object.assign(sessionStore, structuredClone(obj)); },
      remove: async (key) => { delete sessionStore[key]; },
    },
  },
  runtime: {
    onMessage: { addListener: (fn) => { onMessage = fn; } }, onInstalled: { addListener: (fn) => { installed = fn; } },
    getManifest: () => ({ version: '0.1.0' }),
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  tabs: {
    query: async () => [{ id: 7, windowId: 70 }], sendMessage: async () => {},
    update: async (tabId, props) => { focusLog.push(['tab', tabId, props.active]); },
  },
  windows: { update: async (windowId, props) => { focusLog.push(['win', windowId, props.focused]); } },
};
let toolGate = null;           // held tools/call responses (mid-flight permission change test)
const toolCallParams = [];     // every tools/call params seen (request_id propagation)
let toolsListRequests = 0;     // how many tools/list round-trips the page heartbeat actually caused

class FakeWebSocket {
  static OPEN = 1; static CONNECTING = 0;
  constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 5); }
  send(raw) {
    const msg = JSON.parse(raw);
    if (msg.id === undefined) return;
    const results = {
      initialize: { serverInfo: { name: 'fake' } },
      'tools/list': { tools: [{ name: 'take_screenshot', description: 'view', inputSchema: { type: 'object', properties: {} } }] },
      'tools/call': { content: [{ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }] },
      ping: {},
    };
    const respond = () => setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: results[msg.method] ?? {} }) }), 2);
    if (msg.method === 'tools/list') toolsListRequests += 1;
    if (msg.method === 'tools/call') {
      toolCallParams.push(msg.params ?? {});
      if (toolGate) { const gate = toolGate; toolGate = null; gate.then(respond); return; }
    }
    respond();
  }
  close() { this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = FakeWebSocket;
// Hermetic: discovery must never talk to a REAL bridge that happens to run on this machine (the test
// would otherwise see servers that are not in the mock storage). `bridgeProbe` simulates a live bridge.
let bridgeProbe = null;
globalThis.fetch = async (url) => {
  if (!bridgeProbe) throw new TypeError('fetch is mocked out in tests');
  if (String(url).includes('/servers')) return { status: 200, json: async () => bridgeProbe };
  if (String(url).includes('/status')) return { status: 200, json: async () => ({ launcher: false }) };
  throw new TypeError('unexpected fetch in tests');
};

const call = (msg, sender) => new Promise((resolve) => onMessage(msg, sender, resolve));
await import('../background/background.js');

// 1) Clean install: NO MCP at all (servers belong to the user, not a built-in integration)
await installed();
let state = await call({ type: 'GET_STATE' });
assert.equal(state.servers.length, 0);
assert.equal((await call({ type: 'GET_ACTIVE_TOOLS' })).tools.length, 0);

// 1a) A DISCOVERED (auto) server must survive an invalid servers.json. The bridge answers ok:true with an
// empty list and config_error; that is NOT "the user removed every server", so the entry, its permission
// and its id are preserved (the old code deleted it and re-added it with the default permission).
await chrome.storage.local.set({ wmb_servers: [
  { id: 'auto1', name: 'demo_mcp', url: 'ws://127.0.0.1:8080', enabled: true, permission: 'allow', auto: true },
] });
bridgeProbe = { ok: true, version: '0.1.0', pid: 1, config_error: 'malformed JSON (line 3, column 1)', servers: [] };
const discovery = await call({ type: 'DISCOVER' });
assert.equal(discovery.ok, false, 'discovery reports the invalid config instead of pretending success');
assert.match(discovery.error, /invalid/i);
state = await call({ type: 'GET_STATE' });
assert.equal(state.servers.length, 1, 'a config error never deletes the discovered server');
assert.equal(state.servers[0].permission, 'allow', 'and never resets its permission');
assert.equal(state.servers[0].id, 'auto1', 'and never changes its id');
bridgeProbe = null;
await chrome.storage.local.set({ wmb_servers: [] });

// 1b) A server the DISCOVERY put in storage (the only way servers exist now) connects on its own.
// The first one is enabled while no other one is active; its permission defaults to the global default.
await chrome.storage.local.set({ wmb_servers: [{ id: 'srv1', name: 'demo_mcp', url: 'ws://localhost:8080', enabled: true, permission: 'ask' }] });
await installed();
await new Promise((r) => setTimeout(r, 300)); // margin for reconcile() + the fake MCP handshake
state = await call({ type: 'GET_STATE' });
assert.equal(state.servers.length, 1);
assert.equal(state.servers[0].enabled, true);
assert.equal(state.servers[0].status, 'connected');
assert.equal(state.servers[0].permission, 'ask');
assert.equal(state.servers[0].slug, 'demo_mcp');
const id = state.servers[0].id;

// 3) "ask" permission: there are tools; the image arrives intact from the MCP
let tools = await call({ type: 'GET_ACTIVE_TOOLS' });
assert.equal(tools.tools.length, 1);
const listRoundTrips = toolsListRequests;
await call({ type: 'GET_ACTIVE_TOOLS' });
assert.equal(toolsListRequests, listRoundTrips, 'the 10 s heartbeat is served from the tools cache, not a new handshake');
let res = await call({ type: 'CALL_TOOL', server: 'demo_mcp', name: 'take_screenshot', arguments: {} });
assert.equal(res.result.content[0].type, 'image');
assert.equal(res.result.content[0].data, 'QUJD');

// 4) Global and per-MCP selector
assert.equal((await call({ type: 'SET_ALL_PERMISSIONS', permission: 'allow' })).ok, true);
state = await call({ type: 'GET_STATE' });
assert.equal(state.servers[0].permission, 'allow');
assert.equal(state.settings.defaultPermission, 'allow');
assert.match((await call({ type: 'SET_PERMISSION', id, permission: 'always' })).error, /Invalid permission/);

// 5) A server discovered later without its own permission inherits the global default
await chrome.storage.local.set({ wmb_servers: [
  { id: 'srv1', name: 'demo_mcp', url: 'ws://localhost:8080', enabled: true, permission: 'allow' },
  { id: 'srv2', name: 'other', url: 'ws://localhost:9001', enabled: false },
] });
state = await call({ type: 'GET_STATE' });
assert.equal(state.servers.find((s) => s.name === 'other').permission, 'allow');

// 5b) permission turned to «deny» WHILE the tool runs → the result is a refusal (rejected), and the
// controller's request_id travels end-to-end in the MCP _meta.
await call({ type: 'SET_PERMISSION', id, permission: 'allow' });
let releaseTool;
toolGate = new Promise((resolve) => { releaseTool = resolve; });
const inFlight = call({ type: 'CALL_TOOL', server: 'demo_mcp', name: 'take_screenshot', arguments: {}, request_id: 'req-mid-flight' });
await new Promise((r) => setTimeout(r, 20));
await call({ type: 'SET_PERMISSION', id, permission: 'deny' });
releaseTool();
const midFlight = await inFlight;
assert.equal(midFlight.ok, false, 'a call whose permission was revoked mid-flight does not report success');
assert.equal(midFlight.rejected, true, 'it is flagged as a user refusal (rejected), not a tool error');
assert.match(midFlight.error, /revoked permission/i);
assert.equal(toolCallParams.at(-1)._meta?.['longarm/request_id'], 'req-mid-flight', 'the request id reached the JSON-RPC layer');

// 5c) Two tabs detect the same request: the service worker hands it to exactly ONE of them.
const claimA = await call({ type: 'CLAIM_CALL', key: 'same-request', tab_id: 'tab-a' });
const claimA2 = await call({ type: 'CLAIM_CALL', key: 'same-request', tab_id: 'tab-a' });
const claimB = await call({ type: 'CLAIM_CALL', key: 'same-request', tab_id: 'tab-b' });
assert.equal(claimA.fresh, true, 'the first tab claims the call');
assert.equal(claimA2.fresh, true, 'the SAME tab may run it again (batch duplicates are the registry\'s business)');
assert.equal(claimB.fresh, false, 'another tab is told it is already running');
// A claim saved in storage.session survives a service-worker restart.
const persisted = await call({ type: 'CLAIM_CALL', key: 'persisted-request', tab_id: 'tab-new' });
assert.equal(persisted.fresh, false, 'a persisted claim still refuses another tab after a worker restart');

// 5d) CANCEL_TOOL rejects the in-flight promise and notifies the server.
await call({ type: 'SET_PERMISSION', id, permission: 'allow' });
toolGate = new Promise((resolve) => { releaseTool = resolve; });
const cancellable = call({ type: 'CALL_TOOL', server: 'demo_mcp', name: 'take_screenshot', arguments: {}, request_id: 'req-cancel' });
for (let i = 0; i < 100 && !toolCallParams.some((p) => p._meta?.['longarm/request_id'] === 'req-cancel'); i += 1) {
  await new Promise((r) => setTimeout(r, 10)); // wait until the request reached the wire
}
const cancelRes = await call({ type: 'CANCEL_TOOL', request_id: 'req-cancel' });
assert.equal(cancelRes.ok, true);
assert.equal(cancelRes.cancelled, true, 'the pending request was found and cancelled');
const cancelled = await cancellable;
assert.equal(cancelled.ok, false, 'a cancelled call does not report success');
assert.match(cancelled.error, /Cancelled/);
assert.ok(toolCallParams.at(-1)._meta?.['longarm/request_id'] === 'req-cancel', 'the cancelled call had its request id');
releaseTool();

// 6) "Deny": no tools for the AI and the call is also blocked in the background
await call({ type: 'SET_PERMISSION', id, permission: 'deny' });
tools = await call({ type: 'GET_ACTIVE_TOOLS' });
assert.equal(tools.tools.length, 0);
res = await call({ type: 'CALL_TOOL', server: 'demo_mcp', name: 'take_screenshot', arguments: {} });
assert.equal(res.ok, false);
// The refusal is flagged so the controller can answer with the exact «the user did not allow it» text.
assert.equal(res.rejected, true);
assert.match(res.error, /does not allow/);

// 7) The worker only ever talks to THIS machine: a remote server address is refused outright.
const { validateUrl } = await import('../background/store.js');
assert.equal(validateUrl('ws://localhost:8080'), 'ws://localhost:8080');
assert.equal(validateUrl('ws://127.0.0.1:8080/'), 'ws://127.0.0.1:8080');
assert.match((() => { try { validateUrl('wss://example.com:9000/mcp'); return new Error('accepted!'); } catch (e) { return e; } })().message, /local/);

// 8) service worker timer (does not freeze with the tab hidden) and tab "wake-up" with a return to the previous one
const t0 = Date.now();
assert.equal((await call({ type: 'SLEEP', ms: 80 })).ok, true);
assert.ok(Date.now() - t0 >= 70);
const focus = await call({ type: 'FOCUS_TAB' }, { tab: { id: 3, windowId: 30 } });
assert.deepEqual(focus.prev, { tabId: 7, windowId: 70 });
await call({ type: 'RESTORE_FOCUS', prev: focus.prev });
assert.deepEqual(focusLog, [['tab', 3, true], ['win', 30, true], ['tab', 7, true], ['win', 70, true]]);

// 9) The mutation router must NOT resolve names from the object prototype: "constructor" / "toString" are
// not mutations and must fall through to the «Unknown message» answer, not run an inherited function.
for (const bogus of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
  const res = await call({ type: bogus });
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown message/);
}

console.log('✔ test_background: all checks passed');
process.exit(0); // the service worker keepalive keeps the process alive
