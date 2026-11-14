// Tests the adapters: one per supported site, each with the full selector contract.
//
// The site-specific half of the extension is only ever exercised on a real chat page, so a typo here fails
// silently in production: a broken selector makes `querySelectorAll` throw, the caller skips it inside a
// try/catch, and the site quietly stops detecting calls (or stops hiding anything). This test loads every adapter
// the way the manifest does — base_adapter.js first, then each site — and checks the contract each one declares:
//
//   · it registers, matches its own hostname and no other site's,
//   · the four required selector lists (composer, sendButton, assistantMessages, stopButton) are non-empty
//     arrays of plausible CSS selectors, and `userMessages` (the user's own turns) is honest about being there,
//   · every hostname of the extension has exactly one adapter.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { SUPPORTED_URL_PATTERNS, PERMISSIONS } from '../shared/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ───────────────────────── Load each adapter exactly like the manifest does ─────────────────────────

// The adapters are content scripts: they may touch `location` while being constructed (DeepSeek reads the
// conversation id from the path). Nothing else of the page is needed for a contract check.
const context = vm.createContext({ console, setTimeout, clearTimeout, location: { pathname: '/', hostname: 'localhost' } });
vm.runInContext(read('content_scripts/constants.js'), context);
vm.runInContext(read('content_scripts/utils.js'), context);
vm.runInContext(read('content_scripts/adapters/base_adapter.js'), context);
const adapters = [];
vm.runInContext('globalThis.WMB.adapters = []; globalThis.WMB.registerAdapter = (a) => globalThis.WMB.adapters.push(a);', context);

const files = readdirSync(new URL('../content_scripts/adapters', import.meta.url)).filter((f) => f.endsWith('.js') && f !== 'base_adapter.js').sort();
assert.ok(files.length >= 4, `four site adapters, found: ${files.join(', ')}`);
for (const file of files) vm.runInContext(read(`content_scripts/adapters/${file}`), context);
const registered = context.WMB.adapters;
assert.equal(registered.length, files.length, 'every adapter file registered one adapter');

// ───────────────────────── The contract of each one ─────────────────────────

const REQUIRED = ['composer', 'sendButton', 'assistantMessages', 'stopButton'];
/** Cheap syntax guard: the shapes a CSS selector list may contain, with its brackets and quotes balanced. */
const plausibleSelector = (selector) => {
  if (typeof selector !== 'string' || !selector.trim()) return false;
  if (/\s{2,}/.test(selector)) return false;
  for (const [open, close] of [['[', ']'], ['(', ')']]) {
    if ((selector.split(open).length - 1) !== (selector.split(close).length - 1)) return false;
  }
  const quotes = (selector.match(/"/g) ?? []).length;
  return quotes % 2 === 0;
};

const sites = new Set();
for (const adapter of registered) {
  const where = adapter.id ?? adapter.name;
  assert.ok(adapter.id && adapter.name, `${where}: it has an id and a name`);
  for (const key of REQUIRED) {
    const list = adapter.selectors?.[key];
    assert.ok(Array.isArray(list) && list.length, `${where}: «${key}» is a non-empty list`);
    for (const selector of list) assert.ok(plausibleSelector(selector), `${where}: «${selector}» in ${key} looks like a selector`);
  }
  // `userMessages` is optional (a site may not expose the user's turns): when it is declared, it must be sound.
  for (const selector of adapter.selectors.userMessages ?? []) {
    assert.ok(plausibleSelector(selector), `${where}: «${selector}» in userMessages looks like a selector`);
  }
  // What the settings may hold, and nothing else.
  assert.ok(PERMISSIONS.includes('ask'), 'shared constants loaded');

  // Its hostname(s): each adapter matches its own site and no other adapter's.
  const hosts = SUPPORTED_URL_PATTERNS.map((pattern) => new URL(pattern.replace('*', '')).hostname);
  const mine = hosts.filter((host) => adapter.matches(host));
  assert.ok(mine.length >= 1, `${where}: matches the hostname(s) it claims (${hosts.join(', ')})`);
  for (const host of mine) {
    const others = registered.filter((other) => other !== adapter && other.matches(host));
    assert.equal(others.length, 0, `${where}: no other adapter matches ${host}`);
    sites.add(host);
  }
}

// ───────────────────────── Every supported site has an adapter ─────────────────────────

const hosts = SUPPORTED_URL_PATTERNS.map((pattern) => new URL(pattern.replace('*', '')).hostname);
for (const host of hosts) {
  assert.ok(sites.has(host), `${host} is covered by an adapter`);
}
assert.equal(sites.size, hosts.length, 'one adapter per supported site, no duplicates');

// The cleanup reads these two lists from the adapter (hide.js): a site that declares neither would only be
// covered by the generic fallback, which is exactly the drift this contract prevents.
const withBoth = registered.filter((a) => a.selectors.userMessages?.length && a.selectors.assistantMessages?.length);
assert.ok(withBoth.length >= 3, 'at least three sites declare both their assistant and their user selectors');

console.log(`✔ test_adapters: ${registered.length} adapters covering ${hosts.join(', ')}`);
