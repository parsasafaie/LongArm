/**
 * store.js — The configuration store: reading, writing and the history.
 *
 * This is the only module that talks to `chrome.storage.local` for the servers, the settings and the history.
 * Every write goes through `withLock`, so two messages arriving at the same time cannot overwrite each other's
 * state (the popup and a content script may both be writing when a change lands).
 *
 * background.js keeps the rest: the connections, the discovery, the call path and the message router.
 */
import { DEFAULT_SETTINGS, HISTORY_LIMIT, PERMISSIONS, STORAGE_KEYS as KEYS } from '../shared/constants.js';

/** Serializes storage mutations to avoid race conditions. */
let lock = Promise.resolve();
export const withLock = (fn) => {
  const run = lock.then(() => fn());
  lock = run.catch(() => {});
  return run;
};

/** The servers and the settings as the extension sees them. */
export async function loadState() {
  const data = await chrome.storage.local.get([KEYS.servers, KEYS.settings]);
  const settings = { ...DEFAULT_SETTINGS, ...(data[KEYS.settings] ?? {}) };
  const servers = (data[KEYS.servers] ?? []).map((s) => ({
    ...s,
    permission: PERMISSIONS.includes(s.permission) ? s.permission : settings.defaultPermission,
  }));
  return { servers, settings };
}

/** Servers that can connect and be used: enabled, with an address and not blocked. */
export const isUsable = (s) => s.enabled && s.url && s.permission !== 'deny';

export const saveServers = (servers) => chrome.storage.local.set({ [KEYS.servers]: servers });

/** Readable, unique identifier the AI will use to name each server. */
export function assignSlugs(servers) {
  const used = new Set();
  const slugs = new Map();
  // Already configured MCPs (with an address) pick first: that way the unconfigured default MCP does not take their name.
  for (const s of [...servers].sort((a, b) => Boolean(b.url) - Boolean(a.url))) {
    const base = s.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp';
    let slug = base;
    for (let n = 2; used.has(slug); n += 1) slug = `${base}_${n}`;
    used.add(slug);
    slugs.set(s.id, slug);
  }
  return slugs;
}

/** One line in the Activity page: what ran, how it went, how long it took. Newest first. */
export async function addHistory(entry) {
  return withLock(async () => {
    const data = await chrome.storage.local.get(KEYS.history);
    const history = [entry, ...(data[KEYS.history] ?? [])].slice(0, HISTORY_LIMIT);
    await chrome.storage.local.set({ [KEYS.history]: history });
  });
}

/** A server address the extension accepts: a ws:// or wss:// URL pointing at THIS machine, without its trailing slash. */
export function validateUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('The address is not valid.'); }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('The address must start with ws:// or wss://');
  // Everything stays on this computer: a remote address is refused, not merely unusual.
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('The address must be local (localhost, 127.0.0.1 or ::1).');
  }
  return url.toString().replace(/\/$/, '');
}
