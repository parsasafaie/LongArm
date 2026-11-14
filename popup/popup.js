/**
 * popup.js - Extension control panel.
 *
 * The popup is an app shell: the side rail switches between three pages (Servers, Activity, Settings)
 * and carries the master switch, while each page shows its own head with the actions that belong to it.
 * MCP servers are the entries registered in server/servers.json; the extension detects them by
 * itself, and here they are only enabled and given a permission. The cards are reused across
 * refreshes (they are not recreated), so transitions animate instead of jumping.
 */
import { MAX_ACTIVE_SERVERS, RECOMMENDED_ACTIVE_SERVERS, PERMISSIONS, PERMISSION_LABELS } from '../shared/constants.js';

const $ = (selector, root = document) => root.querySelector(selector);
const STATUS_TEXT = {
  connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected (retrying)', error: 'Connection error',
};
const STATUS_SHORT = { connected: 'Connected', connecting: 'Connecting', disconnected: 'Retrying', error: 'Error' };
const STATUS_CHIP = { connected: 'ok', connecting: 'warn', disconnected: 'warn', error: 'bad' };
/** Short labels for the segmented control; the full wording stays in its title and in the hint. */
const PERM_SHORT = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };
const PERM_NOTES = {
  allow: 'Runs without asking',
  ask: 'Asks you before every call',
  deny: 'Blocked: its tools are not described to the AI',
};

const ICONS = {
  grid: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  sliders: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h8M16 17h4"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="14" cy="17" r="2"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  power: '<svg viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
};

/**
 * Puts one of the icons above into an element. The strings are constants of this file — never user or remote
 * text — and they are turned into real SVG nodes here instead of assigning `innerHTML`, which is what the
 * add-on review flags as an unsafe assignment. Parsed as HTML, not as `image/svg+xml`: nodes imported from
 * an XML document lose their SVG interface in current Chromium (the `viewBox` geometry stops applying and
 * every icon renders blank), while the HTML parser builds the same tree with the namespace it needs.
 */
function setIcon(el, svg) {
  if (!svg) return;
  el.replaceChildren(document.importNode(new DOMParser().parseFromString(svg, 'text/html').body.firstChild, true));
}

for (const el of document.querySelectorAll('.ico[data-ico]')) setIcon(el, ICONS[el.dataset.ico]);

/** Sends a message to the service worker and throws if the response is not ok. */
async function api(type, payload = {}) {
  let res;
  try { res = await chrome.runtime.sendMessage({ type, ...payload }); } catch (err) { throw new Error(err.message); }
  if (!res?.ok) throw new Error(res?.error ?? 'Unknown error.');
  return res;
}

function toast(message, ms = 3200) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { toast(err.message); }
  await refresh(true);
};

const setLabel = (btn, text) => {
  const span = btn.querySelector('span:not(.ico)');
  if (span) span.replaceChildren(text);
  else { // icon-only button (Restart): its label lives in the accessible name, not in a text node
    btn.setAttribute('aria-label', text);
    btn.title = text;
  }
};
const setBusy = (btn, busy) => { btn.disabled = busy; btn.classList.toggle('busy', busy); };

let latest = null; // last received state

// ───────────────────────── Bridge ─────────────────────────

let restarting = false;
let opening = false;
let togglingBridge = false;

function renderBridge(state) {
  const b = state.bridge ?? {};
  const dot = $('#bridge-dot');
  const title = $('#bridge-title');
  const sub = $('#bridge-sub');
  const hint = $('#offline-hint');
  const cfgErr = $('#config-error');

  if (!b.checked) {
    dot.className = 'dot connecting';
    title.textContent = 'Checking the bridge…';
    sub.textContent = '';
  } else if (b.online) {
    dot.className = 'dot online';
    title.textContent = 'Bridge connected';
    const listening = state.servers.filter((s) => s.bridgeStatus === 'listening').length;
    sub.textContent = `v${b.version ?? '?'} · ${listening} server${listening === 1 ? '' : 's'} published`;
  } else {
    dot.className = 'dot offline';
    title.textContent = 'Bridge off';
    sub.textContent = 'The extension cannot find it on this computer.';
  }

  cfgErr.hidden = !(b.online && b.configError);
  if (!cfgErr.hidden) cfgErr.textContent = `servers.json has an error: ${b.configError}. Fix it and save: the bridge reloads it on its own (until then it keeps using the previous configuration).`;

  hint.hidden = !(b.checked && !b.online);
  if (!hint.hidden) {
    if (b.launcherOnline) {
      hint.textContent = b.paused
        ? 'The bridge is off on purpose. Press \u00abStart bridge\u00bb to turn it on.'
        : 'The bridge went down; the launcher is bringing it back up. If it does not return, press \u00abStart bridge\u00bb.';
    } else {
      hint.replaceChildren('To turn it on from here, install the launcher once: double-click ', Object.assign(document.createElement('code'), { textContent: 'server/install.cmd' }),
        '. In the meantime you can start it manually with ', Object.assign(document.createElement('code'), { textContent: 'server/start_bridge_loop.pyw' }), '.');
    }
  }

  const toggle = $('#toggle-bridge');
  if (!togglingBridge) {
    setLabel(toggle, b.online ? 'Stop' : 'Start');
    toggle.disabled = !b.checked || !b.launcherOnline;
    toggle.title = b.launcherOnline
      ? (b.online ? 'Turns the bridge off (it stays off until you start it again)' : 'Turns the bridge on')
      : 'It needs the launcher: install it once with server/install.cmd';
  }

  const restart = $('#restart-bridge');
  if (!restarting) {
    restart.disabled = !b.online;
    restart.title = !b.online ? 'The bridge is off' : 'Closes and reopens the bridge (reloads servers.json and the MCPs)';
  }
  $('#open-config').title = b.config ? `Open ${b.config}` : 'Open servers.json in your editor';
}

$('#open-config').addEventListener('click', async (event) => {
  if (opening) return;
  opening = true;
  setBusy(event.currentTarget, true);
  try {
    await api('OPEN_CONFIG');
    toast('Opening servers.json… save the file and the bridge reloads it on its own.');
  } catch (err) {
    const path = latest?.bridge?.config;
    toast(path && !err.message.includes(path) ? `${err.message} File: ${path}` : err.message, 6500);
  } finally {
    opening = false;
    setBusy(event.currentTarget, false);
  }
});

$('#toggle-bridge').addEventListener('click', async (event) => {
  if (togglingBridge) return;
  const btn = event.currentTarget;
  const turnOff = Boolean(latest?.bridge?.online);
  togglingBridge = true;
  setBusy(btn, true);
  setLabel(btn, turnOff ? 'Stopping\u2026' : 'Starting\u2026');
  try {
    const res = await api(turnOff ? 'STOP_BRIDGE' : 'START_BRIDGE');
    toast(turnOff ? 'Bridge stopped.' : (res.configError ? 'Bridge started, but servers.json has an error.' : 'Bridge started \u2713'), 4200);
  } catch (err) {
    toast(err.message, 7000);
  } finally {
    togglingBridge = false;
    setBusy(btn, false);
    await refresh(true);
  }
});
$('#restart-bridge').addEventListener('click', async (event) => {
  if (restarting) return;
  const btn = event.currentTarget;
  restarting = true;
  setBusy(btn, true);
  setLabel(btn, 'Restarting…');
  try {
    const res = await api('RESTART_BRIDGE');
    toast(res.configError ? 'Bridge restarted, but servers.json has an error.' : 'Bridge restarted ✓', 4200);
  } catch (err) {
    toast(err.message, 7000);
  } finally {
    restarting = false;
    setBusy(btn, false);
    setLabel(btn, 'Restart bridge');
    await refresh(true);
  }
});

// ───────────────────────── Servers ─────────────────────────

const cards = new Map();        // id → { li, els, server }

/** Marks the active option of a segmented control; `mixed` (or any unknown value) leaves all of them unselected. */
function setSegValue(seg, value) {
  for (const btn of seg.children) {
    const on = btn.dataset.value === value;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', String(on));
  }
  seg.dataset.value = value;
}

/** 3-state segmented control: Allow (Always allow) · Ask (Always ask) · Deny (Never allow). */
function permSelect(onChange, label) {
  const seg = document.createElement('div');
  seg.className = 'seg';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', label);
  for (const perm of PERMISSIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn';
    btn.dataset.value = perm;
    btn.textContent = PERM_SHORT[perm];
    btn.title = PERMISSION_LABELS[perm];
    btn.setAttribute('role', 'radio');
    btn.addEventListener('click', guard(() => onChange(perm)));
    seg.append(btn);
  }
  return seg;
}

function buildCard(server) {
  const card = { server, els: {} };
  const li = document.createElement('li');
  li.className = 'server';

  const toggle = document.createElement('label');
  toggle.className = 'switch';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.addEventListener('change', guard(() => api('TOGGLE_SERVER', { id: card.server.id, enabled: checkbox.checked })));
  toggle.append(checkbox, document.createElement('span'));

  const text = document.createElement('div');
  text.className = 'srv-text';
  const name = document.createElement('div');
  name.className = 'srv-name';
  const title = document.createElement('span');
  title.className = 'title';
  name.append(title);
  const meta = document.createElement('div');
  meta.className = 'srv-meta';
  text.append(name, meta);

  const chip = document.createElement('span');
  chip.className = 'chip';

  const head = document.createElement('div');
  head.className = 'srv-head';
  head.append(toggle, text, chip);

  const perm = permSelect((value) => api('SET_PERMISSION', { id: card.server.id, permission: value }), `Permission for ${server.name}`);
  const foot = document.createElement('div');
  foot.className = 'srv-perm';
  foot.append(perm);

  const note = document.createElement('span');
  note.className = 'srv-note';

  li.append(head, foot, note);
  Object.assign(card, { li, els: { toggle, checkbox, title, meta, chip, perm, note } });
  return card;
}

function updateCard(card, server, activeCount) {
  card.server = server;
  const { li, els } = card;
  li.classList.toggle('on', server.enabled);

  els.toggle.title = server.enabled ? 'Disable' : 'Enable';
  els.checkbox.checked = server.enabled;
  els.checkbox.disabled = !server.enabled && activeCount >= MAX_ACTIVE_SERVERS;
  els.checkbox.setAttribute('aria-label', `Enable ${server.name}`);

  const bridgeBroken = server.bridgeStatus === 'error';
  els.title.textContent = server.name;
  // The tooltip carries the guide: the same text the AI is given about this server.
  els.title.title = server.guide ? `${server.name}\n\n${server.guide}` : server.name;

  // Status chip: what this server is doing right now (the details live in its tooltip and in the meta line).
  const status = bridgeBroken ? 'error' : (server.enabled ? server.status : 'off');
  els.chip.className = `chip${bridgeBroken || server.enabled ? ` ${STATUS_CHIP[status] ?? ''}` : ''}`;
  els.chip.textContent = server.enabled || bridgeBroken ? (STATUS_SHORT[status] ?? status) : 'Off';
  els.chip.title = bridgeBroken ? `The bridge could not open it: ${server.bridgeError ?? 'error'}`
    : (server.enabled && server.error && server.status !== 'connected' ? server.error : (STATUS_TEXT[server.status] ?? ''));

  let meta;
  if (bridgeBroken) meta = `${server.url} · The bridge could not open it: ${server.bridgeError ?? 'error'}`;
  else if (server.permission === 'deny') meta = `${server.url} · Blocked (not described to the AI)`;
  else if (server.enabled) meta = `${server.url}${server.status === 'connected' ? ` · ${server.toolCount} tools` : ''}`;
  else meta = server.url;
  els.meta.textContent = meta;
  els.meta.classList.toggle('err', bridgeBroken);

  setSegValue(els.perm, server.permission);
  els.note.textContent = PERM_NOTES[server.permission] ?? '';
}

function renderServers(state) {
  const list = $('#server-list');
  const active = state.servers.filter((s) => s.enabled);

  // With no ceiling the denominator would read "Infinity", so it is only shown when one exists.
  const denominator = Number.isFinite(MAX_ACTIVE_SERVERS) ? `/${MAX_ACTIVE_SERVERS}` : '';
  $('#counter').textContent = `${active.length}${denominator} active`;
  const tokens = active.reduce((sum, s) => sum + s.approxTokens, 0);
  $('#tokens').textContent = active.length ? `· ≈ ${tokens.toLocaleString('en')} tokens` : '';

  const warning = $('#warning');
  warning.hidden = active.length <= RECOMMENDED_ACTIVE_SERVERS;
  warning.textContent = `${active.length} MCPs are active. Every tool costs context in each chat: one at a time is recommended.`;
  $('#empty').hidden = state.servers.length > 0;

  const seen = new Set();
  state.servers.forEach((server, index) => {
    seen.add(server.id);
    let card = cards.get(server.id);
    if (!card) {
      card = buildCard(server);
      cards.set(server.id, card);
      card.li.classList.add('enter');
      card.li.style.setProperty('--i', index);
      card.li.addEventListener('animationend', (e) => { if (e.target === card.li) card.li.classList.remove('enter'); });
    }
    updateCard(card, server, active.length);
    if (list.children[index] !== card.li) list.insertBefore(card.li, list.children[index] ?? null);
  });
  for (const [id, card] of cards) {
    if (seen.has(id)) continue;
    cards.delete(id);
    card.li.classList.add('leaving');
    setTimeout(() => card.li.remove(), 260);
  }
}

/** Global selector: shows nothing selected («Mixed») when the MCPs differ. */
function renderGlobalPermission(servers) {
  const perms = new Set(servers.map((s) => s.permission));
  const value = perms.size === 1 ? [...perms][0] : (perms.size === 0 ? 'ask' : 'mixed');
  setSegValue($('#perm-all'), value);
  $('#perm-all').closest('.perm-all').hidden = servers.length === 0;
  $('#perm-hint').textContent = {
    allow: 'All of them are allowed: nothing is ever asked.',
    ask: 'The AI is asked on every call.',
    deny: 'All blocked: the AI receives no tools.',
    mixed: 'Each MCP has a different permission.',
  }[value];
}
// Built once, into the box the page provides; the wrapper is hidden when there is no server at all.
const globalSeg = permSelect((value) => api('SET_ALL_PERMISSIONS', { permission: value }), 'Permission for all MCPs');
$('#perm-all').append(...globalSeg.childNodes);

// ───────────────────────── Diagnostics ─────────────────────────
// One JSON with everything a bug report needs: versions, the bridge as the extension sees it, the servers,
// the settings and the last calls. Stays local: it is only COPIED, the user pastes it wherever they want.

$('#copy-diagnostics').addEventListener('click', guard(async () => {
  const [state, { history }] = await Promise.all([api('GET_STATE'), api('GET_HISTORY')]);
  const diagnostics = {
    when: new Date().toISOString(),
    extension: { version: state.version, userAgent: navigator.userAgent },
    bridge: state.bridge,
    servers: state.servers.map(({ name, url, enabled, permission, status, error, toolCount, bridgeStatus, bridgeError, auto, guide }) => ({
      name, url, enabled, permission, status, error, toolCount, bridgeStatus, bridgeError, auto,
      guideChars: typeof guide === 'string' ? guide.length : 0,
    })),
    settings: state.settings,
    history: history.slice(0, 20),
  };
  const text = JSON.stringify(diagnostics, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast('Diagnostics copied as JSON. Paste it into your bug report.');
  } catch {
    toast('The clipboard is blocked here: select and copy from the console instead.');
    console.log('[LongArm diagnostics]', text);
  }
}));

// ───────────────────────── History ─────────────────────────

let historySig = '';
async function renderHistory() {
  const { history } = await api('GET_HISTORY');
  const sig = JSON.stringify(history);
  if (sig === historySig) return;
  historySig = sig;
  const list = $('#history-list');
  list.replaceChildren();
  $('#history-count').textContent = history.length ? `${history.length} call${history.length === 1 ? '' : 's'}` : '';
  $('#history-empty').hidden = history.length > 0;
  history.forEach((h, index) => {
    const li = document.createElement('li');
    li.className = h.status === 'ok' ? 'ok' : 'error';
    li.style.setProperty('--i', Math.min(index, 10));
    const row = document.createElement('div');
    row.className = 'tl-row';
    const title = document.createElement('strong');
    title.textContent = `${h.server} › ${h.tool}`;
    title.title = title.textContent;
    const status = document.createElement('span');
    status.className = `tl-status${h.status === 'ok' ? '' : ' error'}`;
    status.textContent = h.status === 'ok' ? `OK${h.ms ? ` · ${h.ms} ms` : ''}` : 'Error';
    row.append(title, status);
    const detail = document.createElement('small');
    detail.textContent = `${new Date(h.ts).toLocaleTimeString('en')} · ${h.error ?? h.args}`;
    li.append(row, detail);
    list.append(li);
  });
}
$('#clear-history').addEventListener('click', guard(async () => { await api('CLEAR_HISTORY'); historySig = ''; }));

// ───────────────────────── Settings ─────────────────────────

function renderSettings(state) {
  const { settings } = state;
  $('#master').checked = settings.bridgeEnabled;
  $('#master-label').textContent = settings.bridgeEnabled ? 'Enabled' : 'Disabled';
  $('#main').classList.toggle('off', !settings.bridgeEnabled);
  if (document.activeElement?.id !== 'set-maxResultChars') $('#set-maxResultChars').value = settings.maxResultChars;
  $('#set-autoSend').checked = settings.autoSend;
  $('#set-hideProtocol').checked = settings.hideProtocol !== false;
  $('#set-autoEnableDiscovered').checked = Boolean(settings.autoEnableDiscovered);
  $('#set-focusFallback').checked = settings.focusFallback;

  $('#version').textContent = state.version ? `v${state.version}` : '';
  $('#version-line').textContent = state.version ? `LongArm v${state.version}` : '';
}

$('#master').addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { bridgeEnabled: e.target.checked } })));

for (const key of ['autoSend', 'hideProtocol', 'focusFallback', 'autoEnableDiscovered']) {
  $(`#set-${key}`).addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { [key]: e.target.checked } })));
}
$('#discover-now').addEventListener('click', guard(async () => {
  const res = await api('DISCOVER');
  toast(res.added ? `Detected ${res.added} new server(s).` : 'Servers are up to date.');
}));
$('#set-maxResultChars').addEventListener('change', guard((e) => {
  const value = Math.min(100000, Math.max(500, Number(e.target.value) || 12000));
  return api('UPDATE_SETTINGS', { settings: { maxResultChars: value } });
}));

// ───────────────────────── Rail navigation and refresh ─────────────────────────

const railNav = $('.rail-nav');
let currentView = 'servers';
for (const btn of railNav.querySelectorAll('button')) {
  btn.addEventListener('click', () => {
    currentView = btn.dataset.tab;
    for (const b of railNav.querySelectorAll('button')) b.setAttribute('aria-selected', String(b === btn));
    for (const section of document.querySelectorAll('.pane > section')) section.hidden = section.id !== `tab-${currentView}`;
    historySig = '';
    refresh(true);
  });
}

let lastSig = '';
async function refresh(force = false) {
  // Do not re-render while the user is typing in a field.
  if (!force && document.activeElement?.matches('input[type="text"], input[type="number"]')) return;
  try {
    const state = await api('GET_STATE');
    latest = state;
    const sig = JSON.stringify([state.version, state.settings, state.bridge,
      state.servers.map((s) => [s.id, s.name, s.url, s.enabled, s.permission, s.status, s.toolCount, s.auto, s.error, s.bridgeStatus, s.bridgeError])]);
    if (force || sig !== lastSig) {
      lastSig = sig;
      renderBridge(state);
      renderServers(state);
      renderGlobalPermission(state.servers);
      renderSettings(state);
    }
    if (currentView === 'history') await renderHistory();
  } catch (err) { toast(err.message); }
}

refresh(true);
setInterval(refresh, 1500);