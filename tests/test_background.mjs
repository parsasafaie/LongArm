// Tests for the service worker (discovery, permissions, defaults) with the Chrome API mocked.
import assert from 'node:assert/strict';

// ───────── chrome.* and WebSocket mocks ─────────
const store = {};
const focusLog = [];
let onMessage;
let installed;
globalThis.chrome = {
  storage: { local: {
    get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
    set: async (obj) => { Object.assign(store, structuredClone(obj)); },
    remove: async (key) => { delete store[key]; },
  } },
  runtime: {
    onMessage: { addListener: (fn) => { onMessage = fn; } }, onInstalled: { addListener: (fn) => { installed = fn; } },
    getManifest: () => ({ version: '0.0.1' }),
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  tabs: {
    query: async () => [{ id: 7, windowId: 70 }], sendMessage: async () => {},
    update: async (tabId, props) => { focusLog.push(['tab', tabId, props.active]); },
  },
  windows: { update: async (windowId, props) => { focusLog.push(['win', windowId, props.focused]); } },
};
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
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: results[msg.method] ?? {} }) }), 2);
  }
  close() { this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = FakeWebSocket;
// Hermetic: discovery must never talk to a REAL bridge that happens to run on this machine (the test
// would otherwise see servers that are not in the mock storage).
globalThis.fetch = async () => { throw new TypeError('fetch is mocked out in tests'); };

const call = (msg, sender) => new Promise((resolve) => onMessage(msg, sender, resolve));
await import('../background/background.js');

// 1) Clean install: NO MCP at all (servers belong to the user, not a built-in integration)
await installed();
let state = await call({ type: 'GET_STATE' });
assert.equal(state.servers.length, 0);
assert.equal((await call({ type: 'GET_ACTIVE_TOOLS' })).tools.length, 0);

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
