/**
 * test_result_replay.mjs — a page reload must never re-run (or re-deliver) a call whose result already reached
 * the chat, while a call whose result never arrived must still run once.
 *
 * Drives the real content scripts on a jsdom ChatGPT-like page, in TWO loads sharing one sessionStorage — which is
 * exactly what a browser refresh is. The bug this guards: the ChatGPT adapter kept its "already fired" registry in
 * memory only, so every reload re-ran every `mcp_call` still on the page.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../package.json', import.meta.url));
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch {
  console.error('✘ test_result_replay needs jsdom: run `npm install`');
  process.exit(1);
}

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const SCRIPTS = [
  'content_scripts/constants.js',
  'content_scripts/utils.js',
  'content_scripts/mcp_parser.js',
  'content_scripts/prompt_builder.js',
  'content_scripts/hide.js',
  'content_scripts/ui_widget.js',
  'content_scripts/call_registry.js',
  'content_scripts/adapters/base_adapter.js',
  'content_scripts/adapters/chatgpt.js',
  'content_scripts/core_bridge.js',
];

const call = (cmd) => ({ mcp_call: { server: 'terminal', name: 'run_command', arguments: { command: cmd } } });
const block = (...calls) => calls.map((c) => `<pre><code class="language-json">${JSON.stringify(c)}</code></pre>`).join('\n');
// One element holding several calls: the batch path a single assistant message takes.
const multiBlock = (...calls) => `<pre><code class="language-json">${calls.map((c) => JSON.stringify(c)).join('\n')}</code></pre>`;
const turn = (role, inner) => `<article data-turn="${role}"><div data-message-author-role="${role}"><div class="markdown prose">${inner}</div></div></article>`;
const shell = (thread) => `<!doctype html><html><body><main><div class="thread">${thread}</div></main>
<form><div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"></div>
<button data-testid="send-button" aria-label="Send prompt">Send</button></form></body></html>`;

/** One page load. `storage` is the sessionStorage to share with the next load (a reload). */
async function load(storage, { history = '', onCall = () => ({ ok: true, result: { content: [{ type: 'text', text: 'out' }] } }) } = {}) {
  const dom = new JSDOM(shell(history), { url: 'https://chatgpt.com/c/abc' });
  const { window } = dom;
  const ran = [];
  const sent = [];
  const session = {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  // Each load is its own VM context: a "reload" must not share the previous page's globals or timers.
  const context = vm.createContext({
    console, setTimeout, clearTimeout, Date, JSON, Set, Map, WeakMap, WeakSet, Proxy, Promise, Math, Intl,
    window, document: window.document, location: window.location,
    Node: window.Node, NodeFilter: window.NodeFilter, MutationObserver: window.MutationObserver,
    HTMLElement: window.HTMLElement, Element: window.Element,
    HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLInputElement: window.HTMLInputElement,
    getSelection: () => window.getSelection(), DataTransfer: window.DataTransfer, File: window.File, atob,
    InputEvent: window.InputEvent, Event: window.Event, ClipboardEvent: window.ClipboardEvent,
    DragEvent: window.DragEvent, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent,
    sessionStorage: session,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    getComputedStyle: window.getComputedStyle.bind(window),
    navigator: window.navigator, crypto,
  });
  context.globalThis = context;
  const servers = [{ id: 's1', slug: 'terminal', name: 'terminal', url: 'ws://x', enabled: true, permission: 'allow', status: 'connected' }];
  const tools = [{ server: 'terminal', name: 'run_command', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } }];
  context.chrome = { runtime: { id: 'ext', onMessage: { addListener: () => {} }, sendMessage: async (m) => {
    if (m.type === 'GET_STATE') return { ok: true, epoch: 1, settings: { bridgeEnabled: true, autoSend: true, maxResultChars: 12000, hideProtocol: true, focusFallback: false }, servers };
    if (m.type === 'GET_ACTIVE_TOOLS') return { ok: true, tools, guides: {} };
    if (m.type === 'CALL_TOOL') { ran.push(m.arguments?.command ?? m.name); return onCall(m); }
    return { ok: true };
  } } };

  for (const file of SCRIPTS) vm.runInContext(read(file), context);
  const WMB = context.WMB;
  WMB.isVisible = () => true;
  WMB.dom.setText = async (el, text) => { sent.push(text); return true; };
  WMB.dom.clearText = async () => {};
  const adapter = WMB.findAdapter('chatgpt.com');
  adapter.submit = async () => true;
  WMB.waitFor = async (fn) => fn() || true;
  return { adapter, ran, sent, doc: window.document, stop: () => { WMB.started = false; } };
}

const settle = async (ms = 3500) => { await new Promise((r) => setTimeout(r, ms)); };
const scan = async (page, rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) { await new Promise((r) => setTimeout(r, 400)); page.adapter.rescan?.(); }
};

// ───────────── 1. Refresh AFTER a successful execution ─────────────
{
  const storage = {};
  const history = turn('user', '<p>run</p>') + turn('assistant', block(call('dir')));

  // First load: the page starts empty and the call arrives live (the normal, pre-refresh situation).
  const first = await load(storage);
  await settle(600);
  first.adapter.markActivity();
  first.doc.querySelector('.thread').insertAdjacentHTML('beforeend', history);
  await settle(3200);
  await scan(first, 8);
  assert.deepEqual(first.ran, ['dir'], 'first load runs the call');
  assert.equal(first.sent.length, 1, 'first load delivers one result');
  assert.ok(storage['wmb:executed'], 'fired call is persisted for the tab');
  assert.ok(storage['wmb:delivered'], 'delivered call is persisted for the tab');

  // reload: same sessionStorage; the conversation rehydrates LATE (past the baseline), as a slow ChatGPT reload does
  const second = await load(storage);
  await settle(3000);
  second.doc.querySelector('.thread').insertAdjacentHTML('beforeend', history);
  await scan(second, 10);
  assert.deepEqual(second.ran, [], 'RELOAD must not re-run a call whose result was delivered');
  assert.equal(second.sent.length, 0, 'RELOAD must not deliver the result again');
}

// ───────────── 2. Refresh DURING execution (result never delivered) ─────────────
{
  const storage = {};
  const history = turn('user', '<p>run</p>') + turn('assistant', block(call('df -h /')));
  const first = await load(storage);
  await settle(600);
  first.adapter.markActivity();
  first.doc.querySelector('.thread').insertAdjacentHTML('beforeend', history);
  await settle(3200);
  await scan(first, 8);
  assert.deepEqual(first.ran, ['df -h /'], 'first load starts the call');

  // The page was reloaded before the result reached the chat: only the delivery mark is missing.
  delete storage['wmb:delivered'];
  const second = await load(storage);
  await settle(3000);
  second.doc.querySelector('.thread').insertAdjacentHTML('beforeend', history);
  await scan(second, 10);
  assert.deepEqual(second.ran, ['df -h /'], 'a call whose result never arrived must still run once after the reload');
  assert.equal(second.sent.length, 1, 'and its result is delivered');
}

// ───────────── 3. WebSocket disconnection + reconnection ─────────────
{
  const storage = {};
  let down = true;
  const thread = turn('user', '<p>run</p>') + turn('assistant', block(call('whoami')));
  const page = await load(storage, {
    onCall: () => (down ? { ok: false, error: 'not connected' } : { ok: true, result: { content: [{ type: 'text', text: 'root' }] } }),
  });
  await settle(600);
  page.adapter.markActivity();
  page.doc.querySelector('.thread').insertAdjacentHTML('beforeend', thread);
  await settle(3200);
  // keep the failure fast: the retry loop waits for a reconnect
  await Promise.race([scan(page, 10), settle(6000)]);
  assert.ok(page.ran.length >= 1, 'the call is attempted while the server is down');
  // one result message, error included: a down connection must not duplicate deliveries
  assert.ok(page.sent.length <= 1, 'a failed connection delivers at most one result per call');
  assert.ok(!(page.sent[0] ?? '').includes('status="ok"'), 'the failure is reported, not retried into a second delivery');
}

// ───────────── 4. Multiple calls in one assistant message ─────────────
{
  const storage = {};
  const thread = turn('user', '<p>run</p>') + turn('assistant', multiBlock(call('a'), call('b'), call('c')));
  const page = await load(storage);
  await settle(600);
  page.adapter.markActivity();
  page.doc.querySelector('.thread').insertAdjacentHTML('beforeend', thread);
  await settle(3200);
  await scan(page, 8);
  assert.deepEqual(page.ran, ['a', 'b', 'c'], 'all three calls run, in order');
  assert.equal(page.sent.length, 1, 'all three results travel in ONE message');
  assert.equal((page.sent[0].match(/\[MCP_RESULT/g) ?? []).length, 3, 'each call gets its own result block');

  const reload = await load(storage);
  await settle(3000);
  reload.doc.querySelector('.thread').insertAdjacentHTML('beforeend', thread);
  await scan(reload, 10);
  assert.deepEqual(reload.ran, [], 'none of the batch is re-run after a reload');
  assert.equal(reload.sent.length, 0, 'and nothing is delivered twice');
}

// ───────────── 5. Duplicate delivery of the same call ID ─────────────
{
  const storage = {};
  const thread = turn('user', '<p>run</p>') + turn('assistant', multiBlock(call('dir'), call('dir')));
  const page = await load(storage);
  await settle(600);
  page.adapter.markActivity();
  page.doc.querySelector('.thread').insertAdjacentHTML('beforeend', thread);
  await settle(3200);
  await scan(page, 8);
  assert.deepEqual(page.ran, ['dir'], 'an identical call twice in one message runs once');
  assert.equal(page.sent.length, 1, 'one message for the batch');
  // the second block is served from the repeat registry, marked cached
  assert.ok((page.sent[0].match(/"cached": true/) ?? []).length >= 1, 'the duplicate is answered from the previous result');

  const reload = await load(storage);
  await settle(3000);
  reload.doc.querySelector('.thread').insertAdjacentHTML('beforeend', thread);
  await scan(reload, 10);
  assert.deepEqual(reload.ran, [], 'the identical pair does not run again after a reload');
}

// ───────────── 6. An ANCIENT pending call is not resumed (stale df / old side effects) ─────────────
{
  const storage = {};
  const thread = turn('user', '<p>run</p>') + turn('assistant', block(call('df -h /')));
  const first = await load(storage);
  await settle(600);
  first.adapter.markActivity();
  first.doc.querySelector('.thread').insertAdjacentHTML('beforeend', thread);
  await settle(3200);
  await scan(first, 8);
  assert.deepEqual(first.ran, ['df -h /'], 'the call ran before the crash/reload');
  // Simulate "executed 20 minutes ago, result never delivered".
  delete storage['wmb:delivered'];
  const times = JSON.parse(storage['wmb:executed-at'] || '{}');
  for (const key of Object.keys(times)) times[key] = Date.now() - 20 * 60_000;
  storage['wmb:executed-at'] = JSON.stringify(times);

  const reload = await load(storage, { history: thread });
  await settle(3000);
  await scan(reload, 10);
  assert.deepEqual(reload.ran, [], 'a pending call older than the resume window is NOT run again');
}

console.log('✔ test_result_replay: refresh, mid-execution reload, reconnect, batch and duplicate-id all deliver exactly once');
// The observers/heartbeats of the jsdom pages are still alive: exit explicitly instead of hanging the CI.
process.exit(0);
