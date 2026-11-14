// Tests the message protocol between the pages and the service worker.
//
// Both sides exchange plain strings ('GET_STATE', 'CALL_TOOL', …) and nothing checks them: the extension APIs
// accept any string, so a renamed or misspelled type is a silent no-op at runtime — the panel simply stops
// updating or a button does nothing. This test reads the sources and fails when
//
//   · a type is SENT by a page (content scripts, popup, welcome) but not handled by the worker,
//   · a type is HANDLED by the worker but sent by nobody (a dead API, unless it is listed below), or
//   · a type is PUSHED into a tab but no content script listens for it.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const filesIn = (dir) => {
  const found = [];
  for (const name of readdirSync(new URL(`../${dir}`, import.meta.url))) {
    const path = join(dir, name);
    if (statSync(new URL(`../${path}`, import.meta.url)).isDirectory()) found.push(...filesIn(path));
    else if (name.endsWith('.js')) found.push(path);
  }
  return found;
};
const collectInto = (set, text, pattern, group = 1) => { for (const match of text.matchAll(pattern)) set.add(match[group]); };

/** Types a page RECEIVES (the worker pushes them): sent by the worker, listened for in the page. */
const RECEIVED_BY_PAGE = ['STATE_CHANGED'];

/** Handlers kept for the API and for tests, with no button sending them yet. Adding one here is a decision. */
const API_ONLY = [];

// ───────────────────────── Every type a page sends ─────────────────────────

const sent = new Set();
for (const file of [...filesIn('content_scripts'), ...filesIn('popup'), ...filesIn('welcome')]) {
  const text = read(file);
  collectInto(sent, text, /type:\s*'([A-Z_]+)'/g);            // send({ type: 'X' }) · WMB.bg({ type: 'X' })
  for (const call of text.matchAll(/\b(?:api|send|run)\(([^)]*)\)/g)) {
    collectInto(sent, call[1] ?? '', /'([A-Z_]+)'/g);          // api('X', …) · api(off ? 'A' : 'B') · run('X', …)
  }
}
assert.ok(sent.has('GET_STATE') && sent.has('CALL_TOOL'), 'the collector found the known sends');

// ───────────────────────── Every type the service worker handles ─────────────────────────

const background = read('background/background.js');
const handled = new Set();
collectInto(handled, background, /case '([A-Z_]+)'/g);         // the switch in handleMessage
collectInto(handled, background, /^ {2}([A-Z_]+): \(/gm);      // the mutation handlers object
assert.ok(handled.has('GET_STATE') && handled.has('SET_PERMISSION'), 'the collector found the known handlers');

// ───────────────────────── The two directions agree ─────────────────────────

const unhandled = [...sent].filter((type) => !handled.has(type) && !RECEIVED_BY_PAGE.includes(type));
assert.deepEqual(unhandled, [], 'every type a page sends is handled by the worker');

const dead = [...handled].filter((type) => !sent.has(type) && !API_ONLY.includes(type));
assert.deepEqual(dead, [], 'every handled type has a sender in the UI (or is listed as API-only)');

// What the worker pushes into a tab must be listened for in the pages.
const pushed = new Set();
collectInto(pushed, background, /tabs\.sendMessage\([^,]+,\s*\{\s*type:\s*'([A-Z_]+)'/g);
assert.ok(pushed.size > 0, 'the worker pushes at least one type into the tabs');
const content = filesIn('content_scripts').map((file) => read(file)).join('\n');
for (const type of pushed) {
  assert.ok(content.includes(`'${type}'`), `a content script listens for «${type}»`);
}

console.log(`✔ test_protocol: ${sent.size} sent · ${handled.size} handled · ${pushed.size} pushed — all consistent`);
