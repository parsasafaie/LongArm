/**
 * background.js — Service Worker (Manifest V3).
 *
 * Responsibilities:
 *   1. Keep a WebSocket connection ONLY with the enabled MCP servers.
 *   2. Detect the servers the bridge publishes and reconcile them with what the user has (discovery).
 *   3. Run a tool call and record it in the history (the store lives in store.js).
 *   4. Expose a message API to the popup and content scripts (see `handleMessage`).
 *
 * The file is organized in labelled sections, in this order: connections · discovery · broadcasts and the badge ·
 * queries · mutations (the popup's writes) · bridge and launcher control (the HTTP ports) · message router ·
 * lifecycle. The configuration store is the one part that has been split out (`store.js`), because it is used by
 * every section and depends on none of them. The control section (bridgeFetch / launcherFetch / controlBridge)
 * is deliberately still here: it drives `connections` and `discoverServers`, so splitting it means threading
 * those through as dependencies — worth doing with a real load test of the worker, not blind.
 */
import { McpConnection } from './ws_client.js';
import { addHistory, assignSlugs, isUsable, loadState, saveServers, validateUrl, withLock } from './store.js';
import {
  STORAGE_KEYS as KEYS, MAX_ACTIVE_SERVERS,
  CALL_TIMEOUT_MS, SUPPORTED_URL_PATTERNS, PERMISSIONS,
} from '../shared/constants.js';

/** @type {Map<string, McpConnection>} serverId → connection */
const connections = new Map();

// ───────────────────────── State and storage ─────────────────────────
// Reading and writing the servers, the settings and the history lives in store.js: this file keeps the
// connections, the discovery, the call path and the message router.

// ───────────────────────── Connections ─────────────────────────

// ------------- Automatic detection from the bridge's published list -------------
// The bridge publishes the servers registered in server/servers.json at http://127.0.0.1:8099/servers.
// New entries appear in the extension on their own; removed ones disappear.

let lastDiscovery = 0;

// Local bridge state (the popup polls it; "Restart" and "Open servers.json" use it).
const bridge = {
  checked: false, online: false, version: null, pid: null, config: null, configError: null,
  supervised: false, startedAt: null, servers: [], error: null, launcherOnline: false, paused: false,
};
let lastProbe = 0;
let probing = null;
let storedConfig = null;
chrome.storage.local.get(KEYS.bridge).then((data) => {
  storedConfig = data[KEYS.bridge]?.config ?? null;
  if (!bridge.config) bridge.config = storedConfig;
}).catch(() => {});

/** Only an integer 1–65535 reaches a URL. The setting is interpolated into a http://127.0.0.1:PORT URL, and a
 * crafted value ("8099@evil.com") would turn it into userinfo and send the probe off this machine. Defense in
 * depth: the settings are written by the popup, but UPDATE_SETTINGS accepts any patch over messages. */
const safePort = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
};

async function bridgeFetch(path, { method = 'GET', timeout = 1500 } = {}) {
  const { settings } = await loadState();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${safePort(settings.controlPort, 8099)}${path}`, { method, cache: 'no-store', signal: ctl.signal });
    let body = null;
    try { body = await res.json(); } catch { /* response with no body */ }
    return { status: res.status, body };
  } finally { clearTimeout(timer); }
}

/** Asks the bridge who it is and which servers it publishes. No long waits: if it does not answer, it stays "no connection". */
function probeBridge(force = false) {
  if (!force && Date.now() - lastProbe < 2500) return Promise.resolve(bridge);
  if (probing) return probing;
  probing = (async () => {
    try {
      const { status, body } = await bridgeFetch('/servers');
      if (status !== 200 || !body?.ok) throw new Error('Unexpected response from the bridge.');
      Object.assign(bridge, {
        checked: true, online: true, version: body.version ?? null, pid: body.pid ?? null, config: body.config ?? bridge.config,
        configError: body.config_error ?? null, supervised: Boolean(body.supervised), startedAt: body.started_at ?? null,
        servers: Array.isArray(body.servers) ? body.servers : [], error: null,
      });
      if (body.config && body.config !== storedConfig) {
        storedConfig = body.config;
        chrome.storage.local.set({ [KEYS.bridge]: { config: body.config } }).catch(() => {});
      }
    } catch (err) {
      Object.assign(bridge, {
        checked: true, online: false, pid: null, configError: null, servers: [],
        error: err?.name === 'AbortError' ? 'no response' : (err?.message ?? 'no connection'),
      });
    }
    await probeLauncher();
    lastProbe = Date.now();
    return bridge;
  })().finally(() => { probing = null; });
  return probing;
}
const portOf = (u) => { try { return new URL(u).port; } catch { return ''; } };
const isLocalUrl = (u) => { try { return ['localhost', '127.0.0.1'].includes(new URL(u).hostname); } catch { return false; } };
const safeUrl = (raw) => { try { return validateUrl(String(raw)); } catch { return null; } };

async function discoverServers(force = false) {
  if (!force && Date.now() - lastDiscovery < 8000) return { ok: true, throttled: true };
  lastDiscovery = Date.now();

  const info = await probeBridge(true);
  if (!info.online) return { ok: false, error: 'The bridge was not found. Start it with server/start_bridge_loop.pyw' };

  const list = (Array.isArray(info.servers) ? info.servers : [])
    // `guide` is the text of that server's guide file (guide_path in the registry): what the AI is told about the
    // server, so it is kept with the entry and handed over when the AI asks for the tools.
    .map((s) => ({ name: String(s?.name ?? '').trim(), url: safeUrl(s?.url), guide: typeof s?.guide === 'string' && s.guide.trim() ? s.guide : null }))
    .filter((s) => s.name && s.url);
  const listed = new Set(list.map((s) => s.url));

  return withLock(async () => {
    const { servers, settings: cfg } = await loadState();
    let changed = false;
    let added = 0;

    for (const s of list) {
      const existing = servers.find((x) => x.url === s.url || (isLocalUrl(x.url) && portOf(x.url) === portOf(s.url)));
      if (existing) {
        if (existing.auto && existing.name !== s.name) { existing.name = s.name; changed = true; }
        // The bridge is the source of truth for the URL too: a stale entry pointing at the same port with a
        // wrong scheme/host (an old wss:// against a ws:// port, say) is healed here, or it would block the
        // correct address forever — the port match keeps the entry, so the URL must follow the bridge.
        if (existing.url !== s.url) { existing.url = s.url; changed = true; }
        if ((existing.guide ?? null) !== s.guide) { existing.guide = s.guide; changed = true; } // the file changed
        continue;
      }
      const active = servers.filter((x) => x.enabled).length;
      const enable = cfg.autoEnableDiscovered ? active < MAX_ACTIVE_SERVERS : active === 0;
      servers.push({ id: crypto.randomUUID(), name: s.name, url: s.url, enabled: enable, permission: cfg.defaultPermission, auto: true, guide: s.guide });
      changed = true;
      added += 1;
    }
    const kept = servers.filter((x) => !(x.auto && !listed.has(x.url)));
    if (kept.length !== servers.length) changed = true;
    if (changed) { await saveServers(kept); await reconcile(); scheduleBroadcast(); }
    return { ok: true, changed, added, total: list.length };
  });
}

let broadcastTimer = null;
function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(async () => {
    const tabs = await chrome.tabs.query({ url: SUPPORTED_URL_PATTERNS });
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'STATE_CHANGED' }).catch(() => {});
  }, 300);
}

function onConnectionChange(evt) {
  if (evt.kind === 'tools' || evt.prev === 'connected' || evt.next === 'connected') scheduleBroadcast();
}

/** Aligns the open connections with the servers enabled in storage. */
async function updateBadge(enabled) {
  await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: '#71717a' });
}
async function reconcile() {
  const { servers, settings } = await loadState();
  updateBadge(settings.bridgeEnabled).catch(() => {});
  // With the bridge off, no connection is kept.
  const wanted = new Map((settings.bridgeEnabled ? servers : []).filter(isUsable).slice(0, MAX_ACTIVE_SERVERS).map((s) => [s.id, s]));

  for (const [id, conn] of connections) {
    const target = wanted.get(id);
    if (!target || target.url !== conn.server.url) {
      conn.close();
      connections.delete(id);
    }
  }
  for (const [id, server] of wanted) {
    const existing = connections.get(id);
    if (existing) {
      existing.server = server;
    } else {
      const conn = new McpConnection(server, onConnectionChange);
      connections.set(id, conn);
      conn.connect();
    }
  }
}

// ───────────────────────── Queries ─────────────────────────

async function getSnapshot() {
  discoverServers().catch(() => {});
  probeBridge().catch(() => {});
  const [{ servers, settings }, stored] = await Promise.all([loadState(), chrome.storage.local.get(KEYS.epoch)]);
  const slugs = assignSlugs(servers);
  return {
    ok: true,
    settings,
    epoch: stored[KEYS.epoch] ?? null,
    version: localVersion(),
    bridge: publicBridge(),
    // null rather than Infinity: this crosses a JSON message boundary where Infinity becomes null
    // anyway, and saying it outright is clearer than relying on that.
    max: Number.isFinite(MAX_ACTIVE_SERVERS) ? MAX_ACTIVE_SERVERS : null,
    servers: servers.map((s) => {
      const conn = connections.get(s.id);
      const live = bridge.servers.find((b) => b.url === s.url || (isLocalUrl(s.url) && portOf(b.url) === portOf(s.url)));
      return {
        ...s,
        bridgeStatus: live?.status ?? null,
        bridgeError: live?.error ?? null,
        slug: slugs.get(s.id),
        status: conn?.status ?? 'disconnected',
        error: conn?.lastError ?? null,
        toolCount: conn?.tools.length ?? 0,
        // What the AI pays for when it asks for the tools: the tool schemas AND the guide text.
        approxTokens: conn ? Math.ceil((JSON.stringify(conn.tools).length + (live?.guide?.length ?? 0)) / 4) : 0,
      };
    }),
  };
}

/** Tools of the ACTIVE servers (this is what gets injected into the chat). */
async function getActiveTools() {
  await discoverServers().catch(() => {});
  await reconcile();
  const { servers, settings } = await loadState();
  if (!settings.bridgeEnabled) return { ok: true, tools: [], disabled: true };
  const slugs = assignSlugs(servers);
  const active = servers.filter(isUsable); // blocked MCPs («Never allow») are not described to the AI: saves tokens
  await Promise.all(active.map((s) => connections.get(s.id)?.whenReady(4000)));

  const tools = [];
  const guides = {};        // slug → the server's guide.txt text, written for the AI
  for (const s of active) {
    const slug = slugs.get(s.id);
    if (s.guide) guides[slug] = s.guide;
    for (const t of connections.get(s.id)?.tools ?? []) {
      tools.push({
        server: slug,
        serverLabel: s.name,
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      });
    }
  }
  return { ok: true, tools, guides };
}

async function callTool({ server, name, arguments: args }) {
  const { servers, settings } = await loadState();
  if (!settings.bridgeEnabled) return { ok: false, error: 'The bridge is disabled.' };
  const slugs = assignSlugs(servers);
  const active = servers.filter((s) => s.enabled && s.url);
  const target = server
    ? active.find((s) => slugs.get(s.id) === server || s.name === server || s.id === server)
    : (active.length === 1 ? active[0] : null);

  const label = target ? slugs.get(target.id) : (server ?? '?');
  const entry = { ts: Date.now(), server: label, tool: name, args: JSON.stringify(args ?? {}).slice(0, 300) };
  const fail = async (error, extra) => {
    await addHistory({ ...entry, status: 'error', error });
    return { ok: false, error, ...extra };
  };

  if (!target) return fail(`The server «${label}» is not active.`);
  // The permission says «Never allow»: the flag tells the controller this is a user refusal, and it answers with
  // the exact «the call reached the system, the user did not allow it» text the AI is given.
  if (target.permission === 'deny') return fail('The user does not allow this tool.', { rejected: true });
  const conn = connections.get(target.id);
  if (conn && conn.status !== 'connected') conn.connect(); // without waiting for the backoff: reconnects right away
  if (!conn || !(await conn.whenReady(10_000))) return fail(`The server «${label}» is not connected.`);
  if (!conn.tools.some((t) => t.name === name)) return fail(`The tool «${name}» does not exist in «${label}».`);

  const started = Date.now();
  try {
    const result = await conn.callTool(name, args, CALL_TIMEOUT_MS);
    await addHistory({ ...entry, status: result?.isError ? 'error' : 'ok', ms: Date.now() - started });
    return { ok: true, result };
  } catch (err) {
    await addHistory({ ...entry, status: 'error', error: err.message, ms: Date.now() - started });
    return { ok: false, error: err.message };
  }
}

// ───────────────────────── Mutations (from the popup) ─────────────────────────

const mutate = (fn) => withLock(async () => {
  const { servers, settings } = await loadState();
  const result = await fn(servers, settings);
  await reconcile();
  scheduleBroadcast();
  return result ?? { ok: true };
});

const mutations = {
  /** Permission for ONE MCP: allow (Always allow) · ask (Always ask) · deny (Never allow). */
  SET_PERMISSION: ({ id, permission }) => mutate(async (servers) => {
    if (!PERMISSIONS.includes(permission)) throw new Error('Invalid permission.');
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error('Server not found.');
    server.permission = permission;
    await saveServers(servers);
  }),

  /** Same selector for ALL the MCPs (and for those added later). */
  SET_ALL_PERMISSIONS: ({ permission }) => mutate(async (servers, settings) => {
    if (!PERMISSIONS.includes(permission)) throw new Error('Invalid permission.');
    servers.forEach((s) => { s.permission = permission; });
    await saveServers(servers);
    await chrome.storage.local.set({ [KEYS.settings]: { ...settings, defaultPermission: permission } });
  }),

  TOGGLE_SERVER: ({ id, enabled }) => mutate(async (servers) => {
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error('Server not found.');
    // Kept so MAX_ACTIVE_SERVERS stays the one knob it always was: at its current value of
    // Infinity this never fires, but setting it to a number brings the ceiling back here, in the
    // injection slice and in the popup's checkbox, all at once.
    if (enabled && servers.filter((s) => s.enabled && s.id !== id).length >= MAX_ACTIVE_SERVERS) {
      throw new Error(`You can only have ${MAX_ACTIVE_SERVERS} active MCP servers at a time.`);
    }
    server.enabled = Boolean(enabled);
    await saveServers(servers);
  }),

  UPDATE_SETTINGS: ({ settings: patch }) => mutate(async (_servers, settings) => {
    await chrome.storage.local.set({ [KEYS.settings]: { ...settings, ...patch } });
  }),
};

// ───────────────────────── Message router ─────────────────────────

/** Timer that does NOT depend on the tab: hidden tabs throttle their setTimeout, the service worker does not. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 30_000)));

async function focusTab(sender) {
  const tab = sender?.tab;
  if (!tab?.id) return { ok: false, error: 'No tab.' };
  const [previous] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  const prev = previous && previous.id !== tab.id ? { tabId: previous.id, windowId: previous.windowId } : null;
  return { ok: true, prev };
}

async function restoreFocus({ prev }) {
  if (!prev) return { ok: true };
  await chrome.tabs.update(prev.tabId, { active: true }).catch(() => {});
  await chrome.windows.update(prev.windowId, { focused: true }).catch(() => {});
  return { ok: true };
}

// ------------- Bridge: restart and open servers.json -------------

const localVersion = () => chrome.runtime.getManifest?.().version ?? '0.0.0';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function publicBridge() {
  const { servers: _servers, ...rest } = bridge;
  return rest;
}

// ------------- Launcher: start / stop / restart the bridge from the panel -------------
// An extension cannot launch processes; server/start_bridge_loop.pyw (port 8098) does it, and it is installed once.

async function launcherFetch(path, { method = 'GET', timeout = 1500 } = {}) {
  const { settings } = await loadState();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${safePort(settings.launcherPort, 8098)}${path}`, { method, cache: 'no-store', signal: ctl.signal });
    let body = null;
    try { body = await res.json(); } catch { /* response with no body */ }
    return { status: res.status, body };
  } finally { clearTimeout(timer); }
}

async function probeLauncher() {
  try {
    const { status, body } = await launcherFetch('/status');
    bridge.launcherOnline = status === 200 && Boolean(body?.launcher);
    bridge.paused = bridge.launcherOnline && Boolean(body?.paused);
  } catch {
    bridge.launcherOnline = false;
    bridge.paused = false;
  }
}

const NO_LAUNCHER = 'The launcher is missing: double-click server/install.cmd (only once) and you will be able to start, stop and restart the bridge from here.';

/** action: 'start' | 'stop' | 'restart'. Asks the launcher for the command and waits to see the real result in the bridge. */
async function controlBridge(action) {
  const before = await probeBridge(true);
  if (!before.launcherOnline) return { ok: false, noLauncher: true, error: NO_LAUNCHER };
  const oldPid = before.online ? before.pid : null;
  try {
    const { status, body } = await launcherFetch(`/${action}`, { method: 'POST', timeout: 5000 });
    if (status !== 200 || !body?.ok) return { ok: false, error: body?.error ?? 'The launcher did not accept the command.' };
  } catch {
    return { ok: false, error: 'Could not reach the launcher.' };
  }
  const wantOnline = action !== 'stop';
  const end = Date.now() + (wantOnline ? 30_000 : 15_000);
  while (Date.now() < end) {
    await delay(700);
    const probe = await probeBridge(true);
    if (!wantOnline) {
      if (!probe.online) { scheduleBroadcast(); return { ok: true, stopped: true }; }
    } else if (probe.online && (action !== 'restart' || oldPid === null || probe.pid !== oldPid)) {
      for (const conn of connections.values()) conn.connect(); // reconnects right away, without waiting for the backoff
      await discoverServers(true).catch(() => {});
      scheduleBroadcast();
      return { ok: true, pid: probe.pid, supervised: probe.supervised, configError: probe.configError };
    }
  }
  return {
    ok: false,
    error: wantOnline ? 'The bridge did not come back on within 30 seconds. Check server/bridge.log.' : 'The bridge did not stop within 15 seconds.',
  };
}
async function restartBridge() {
  const before = await probeBridge(true);
  if (before.launcherOnline && !before.online) return controlBridge('restart');
  if (!before.online) {
    return { ok: false, error: 'The bridge is not on, so there is nothing to restart from here. Start it with server/start_bridge_loop.pyw.' };
  }
  const oldPid = before.pid;
  try {
    const { status, body } = await bridgeFetch('/restart', { method: 'POST', timeout: 4000 });
    if (status !== 200 || !body?.ok) return { ok: false, error: body?.error ?? 'The bridge did not accept the restart.' };
  } catch {
    return { ok: false, error: 'Could not reach the bridge.' };
  }
  // Waits for it to come back as a DIFFERENT process (another pid): that way we know it started from scratch and it is not the old one shutting down.
  const end = Date.now() + 30_000;
  let after = null;
  while (Date.now() < end) {
    await delay(700);
    const probe = await probeBridge(true);
    if (probe.online && probe.pid !== oldPid) { after = probe; break; }
  }
  if (!after) return { ok: false, error: 'The bridge did not come back on within 30 seconds. Check server/bridge.log or start it with start_bridge_loop.pyw.' };
  for (const conn of connections.values()) conn.connect(); // reconnects right away, without waiting for the backoff
  await discoverServers(true).catch(() => {});
  scheduleBroadcast();
  return { ok: true, pid: after.pid, supervised: after.supervised, configError: after.configError };
}

async function openConfig() {
  const info = await probeBridge(true);
  if (!info.online) {
    return { ok: false, offline: true, path: info.config, error: 'The bridge is not on, so I cannot open the file for you.' };
  }
  try {
    const { status, body } = await bridgeFetch('/open-config', { method: 'POST', timeout: 4000 });
    if (status === 404) return { ok: false, path: info.config, error: 'Your bridge does not know how to open the file yet: start it once with server/bridge.cmd and it will.' };
    if (status !== 200 || !body?.ok) return { ok: false, path: info.config, error: body?.error ?? 'Could not open the file.' };
    return { ok: true, path: body.path ?? info.config };
  } catch {
    return { ok: false, path: info.config, error: 'Could not reach the bridge.' };
  }
}

/** After installing or updating the extension, chat tabs that were already open receive the new scripts without reloading. */
async function reinjectContentScripts() {
  if (!chrome.scripting?.executeScript) return;
  for (const cs of chrome.runtime.getManifest?.().content_scripts ?? []) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: cs.matches }); } catch { continue; }
    for (const tab of tabs) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: cs.js }); } catch { /* tab closed or no access */ }
    }
  }
}
async function handleMessage(msg, sender) {
  // hasOwn and not a plain lookup: `mutations` is an object literal, so `msg.type` of "constructor" /
  // "toString" / "valueOf" would resolve a prototype function, call it, and answer the raw message back
  // instead of the «Unknown message» error.
  const handler = Object.hasOwn(mutations, msg.type) ? mutations[msg.type] : null;
  if (handler) return handler(msg);
  switch (msg.type) {
    case 'SLEEP': await sleep(msg.ms); return { ok: true };
    case 'FOCUS_TAB': return focusTab(sender);
    case 'RESTORE_FOCUS': return restoreFocus(msg);
    case 'GET_STATE': return getSnapshot();
    case 'GET_ACTIVE_TOOLS': return getActiveTools();
    case 'CALL_TOOL': return callTool(msg);
    case 'DISCOVER':
      return discoverServers(true);
    case 'RESTART_BRIDGE': return restartBridge();
    case 'START_BRIDGE': return controlBridge('start');
    case 'STOP_BRIDGE': return controlBridge('stop');
    case 'OPEN_CONFIG': return openConfig();
    case 'PROBE_BRIDGE': await probeBridge(true); return { ok: true, bridge: publicBridge() };
    case 'GET_HISTORY': {
      const data = await chrome.storage.local.get(KEYS.history);
      return { ok: true, history: data[KEYS.history] ?? [] };
    }
    case 'CLEAR_HISTORY':
      await chrome.storage.local.remove(KEYS.history);
      return { ok: true };
    case 'RECONNECT':
      connections.get(msg.id)?.close();
      connections.delete(msg.id);
      await reconcile();
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
  return true; // async response
});

// ───────────────────────── Lifecycle ─────────────────────────

// The extension installs with NO MCP: each user registers their own in server/servers.json.
chrome.runtime.onInstalled.addListener(async (details) => {
  // Stamp this install/update: an open chat tab that still runs the PREVIOUS copy of the scripts sees the
  // stamp change and tells the user to reload the page (the build-signature banner only covers text changes).
  await chrome.storage.local.set({ [KEYS.epoch]: Date.now() });
  // Inside the lock: the startup discovery at the bottom of this file (and every SW wake) also does a
  // read-modify-write of the servers — unlocked, the last writer would revert the other's change.
  await withLock(async () => {
    const { servers } = await loadState();
    await saveServers(servers);
  });
  await reconcile();
  if (details?.reason === 'install' || details?.reason === 'update') reinjectContentScripts().catch(() => {});
  if (details?.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') }).catch(() => {});
});
// Safety net: if the SW falls asleep, the alarm wakes it up and reconnects. Sub-minute periods need Chrome 120;
// on older ones (the manifest supports 116+) the value is clamped to one minute — a slower keepalive is fine
// for a safety net, so the 116 support stands.
chrome.alarms.create('wmb-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'wmb-keepalive') { reconcile().catch(() => {}); discoverServers().catch(() => {}); }
});

reconcile().then(() => discoverServers(true)).catch((err) => console.error('[LongArm] reconcile', err));
