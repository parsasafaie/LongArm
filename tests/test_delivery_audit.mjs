/**
 * test_delivery_audit.mjs — regressions for the detection → execution → delivery pipeline:
 *
 *   1. A generic MCP result (`content` + `structuredContent` + an image) loses nothing on its way to the chat.
 *   2. The built-in terminal's report (which carries the clipping/timeout notes structuredContent cannot) is
 *      not replaced by a rebuilt `stdout`/`stderr`.
 *   3. A call indexed as history in conversation A does not make an identical live call in conversation B
 *      look like restored history (same-page navigation).
 *   4. The user sending a staged result (autoSend=false) arms the same delivery bookkeeping an auto-send does.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../package.json', import.meta.url));
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch {
  console.error('✘ test_delivery_audit needs jsdom: run `npm install`');
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
  'content_scripts/adapters/claude.js',
  'content_scripts/core_bridge.js',
];

const call = (cmd) => ({ mcp_call: { server: 'terminal', name: 'run_command', arguments: { command: cmd } } });
const claudeTurn = (role, inner) => (role === 'user'
  ? `<div data-testid="user-message">${inner}</div>`
  : `<div class="font-claude-response">${inner}</div>`);
const claudeShell = (thread) => `<!doctype html><html><body><main><div class="thread">${thread}</div></main>
<fieldset><div contenteditable="true" class="ProseMirror"></div></fieldset></body></html>`;

function load(storage, { url = 'https://claude.ai/chat/a', history = '', onCall, autoSend = true } = {}) {
  const dom = new JSDOM(claudeShell(history), { url });
  const { window } = dom;
  const ran = [];
  const sent = [];
  const session = {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  const context = vm.createContext({
    console, setTimeout, clearTimeout, Date, JSON, Set, Map, WeakMap, WeakSet, Proxy, Promise, Math,
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
  context.chrome = {
    runtime: {
      id: 'ext',
      onMessage: { addListener: () => {} },
      sendMessage: async (m) => {
        if (m.type === 'GET_STATE') {
          return { ok: true, epoch: 1, settings: { bridgeEnabled: true, autoSend, maxResultChars: 12000, hideProtocol: false, focusFallback: false }, servers };
        }
        if (m.type === 'GET_ACTIVE_TOOLS') return { ok: true, tools, guides: {} };
        if (m.type === 'CLAIM_CALL') return { ok: true, fresh: true };
        if (m.type === 'CALL_TOOL') {
          ran.push(m.arguments?.command ?? m.name);
          return onCall ? onCall(m) : { ok: true, result: { content: [{ type: 'text', text: `out:${m.arguments?.command}` }] } };
        }
        return { ok: true };
      },
    },
  };

  for (const file of SCRIPTS) vm.runInContext(read(file), context);
  const WMB = context.WMB;
  WMB.isVisible = () => true;
  WMB.dom.setText = async (el, text, { append = true } = {}) => {
    sent.push(text);
    el.textContent = append && el.textContent ? `${el.textContent}\n${text}` : text;
    return true;
  };
  WMB.dom.clearText = async (el) => { if (el) el.textContent = ''; };
  WMB.waitFor = async (fn) => fn() || true;
  const adapter = WMB.findAdapter('claude.ai');
  adapter.submit = async () => true;
  adapter.attachFiles = async () => true;

  const navigate = (nextUrl, nextThread) => {
    const next = new URL(nextUrl);
    window.history.pushState({}, '', next.pathname + next.search);
    window.document.querySelector('.thread').innerHTML = nextThread ?? '';
  };
  const append = (html) => window.document.querySelector('.thread').insertAdjacentHTML('beforeend', html);
  return { adapter, ran, sent, doc: window.document, context, navigate, append, stop: () => { WMB.started = false; } };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const scan = async (page, rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) { await wait(350); page.adapter.rescan?.(); }
};

// ───────────── 1. Generic content + structuredContent + image: nothing is lost ─────────────
{
  const page = load({}, {
    onCall: () => ({
      ok: true,
      result: {
        content: [
          { type: 'text', text: 'VISIBLE_TEXT' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        structuredContent: { total: 3 },
        isError: false,
      },
    }),
  });
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>go</p>') + claudeTurn('assistant', `<pre>${JSON.stringify(call('echo STRUCT'))}</pre>`));
  await wait(2600);
  await scan(page, 10);
  assert.deepEqual(page.ran, ['echo STRUCT'], 'the call ran');
  assert.equal(page.sent.length, 1, 'one result message');
  assert.ok(page.sent[0].includes('VISIBLE_TEXT'), 'a generic server\'s content text reaches the AI');
  assert.match(page.sent[0], /total/, 'and its structuredContent is not dropped either');
  assert.ok(page.sent[0].includes('terminal_run_command_1.png'), 'an image next to structuredContent is still attached');
  page.stop();
}

// ───────────── 2. The terminal's report (clipping note) is not replaced by raw fields ─────────────
{
  const report = 'exit code: 0 (0.01 s)\n--- stdout ---\nhello\n(stdout went past the read cap: everything past it was discarded)';
  const page = load({}, {
    onCall: () => ({
      ok: true,
      result: {
        content: [{ type: 'text', text: report }],
        structuredContent: { stdout: 'hello', stderr: '', exit_code: 0, duration_ms: 10, timed_out: false },
        isError: false,
      },
    }),
  });
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>go</p>') + claudeTurn('assistant', `<pre>${JSON.stringify(call('echo CLIP'))}</pre>`));
  await wait(2600);
  await scan(page, 10);
  assert.deepEqual(page.ran, ['echo CLIP'], 'the call ran');
  assert.ok(page.sent[0].includes('went past the read cap'), 'the report\'s clipping warning reaches the AI');
  assert.ok(page.sent[0].includes('--- stdout ---'), 'the report itself is the delivered stdout');
  page.stop();
}

// ───────────── 3. Restored history of chat A must not block the same call in chat B ─────────────
{
  const storage = {};
  const a = claudeTurn('user', '<p>a</p>') + claudeTurn('assistant', `<pre>${JSON.stringify(call('echo CROSS'))}</pre>`);
  const page = load(storage, { url: 'https://claude.ai/chat/a', history: a });
  await wait(600);
  await scan(page, 3); // inside the baseline: chat A's history is indexed for this page load
  assert.deepEqual(page.ran, [], 'restored history of chat A never fires');

  page.navigate('https://claude.ai/chat/b', '');
  await scan(page, 3); // the URL change is observed before the user sends
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>b</p>') + claudeTurn('assistant', `<pre>${JSON.stringify(call('echo CROSS'))}</pre>`));
  await wait(2600);
  await scan(page, 12);
  assert.deepEqual(page.ran, ['echo CROSS'], 'an identical live call in chat B is NOT treated as chat A\'s history');
  assert.equal(page.sent.length, 1, 'and its result is delivered');
  page.stop();
}

// ───────────── 4. A manual send of a staged result arms the delivery bookkeeping ─────────────
{
  const storage = {};
  const page = load(storage, { autoSend: false });
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>go</p>') + claudeTurn('assistant', `<pre>${JSON.stringify(call('echo STAGED_BOOK'))}</pre>`));
  await wait(2600);
  await scan(page, 10);
  assert.equal(page.sent.length, 1, 'the result is staged in the composer');
  assert.ok(!storage['wmb:delivered'], 'staging alone is not a delivery');
  assert.equal(page.adapter.lastDeliveryAt, 0, 'and it has not armed any delivery yet');

  // The user presses Enter with the staged text in the composer: trusted send, composer clears, generation starts.
  page.adapter.markActivity();
  page.doc.querySelector('.ProseMirror').textContent = '';
  page.doc.body.insertAdjacentHTML('beforeend', '<button aria-label="Stop response">stop</button>');
  await scan(page, 3);
  assert.ok(storage['wmb:delivered'], 'the manual send marks the call delivered');
  assert.ok(page.adapter.lastDeliveryAt > 0, 'a real delivery time is recorded');
  assert.ok(page.adapter.msgsAtDelivery >= 1, 'the message baseline is recorded');
  assert.equal(page.adapter.deliveries, 1, 'the delivery counter moves, so a later repeat gets a fresh id');
  page.stop();
}

// ───────────── 5. A live reply with NO call sends NOTHING ─────────────
{
  const page = load({});
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>hello</p>') + claudeTurn('assistant', '<p>No tool is needed for this answer.</p>'));
  await wait(2600);
  await scan(page, 8);
  assert.deepEqual(page.ran, [], 'prose without an mcp_call runs nothing');
  assert.equal(page.sent.length, 0, 'and writes no result into the chat');
  page.stop();
}

// ───────────── 6. An echoed frame / placeholder tool is not a request ─────────────
{
  const page = load({});
  await wait(400);
  page.adapter.markActivity();
  const frame = { mcp_call: { server: 'terminal', name: '<tool>', arguments: {} } };
  page.append(claudeTurn('user', '<p>show me the format</p>') + claudeTurn('assistant', `<pre>${JSON.stringify(frame)}</pre>`));
  await wait(2600);
  await scan(page, 8);
  assert.deepEqual(page.ran, [], 'the placeholder frame is not executed');
  assert.equal(page.sent.length, 0, 'and no error result is sent for it');
  page.stop();
}

// ───────────── 7. Two same-tool results in a batch get DISTINCT attachment names ─────────────
{
  const page = load({}, {
    onCall: (m) => ({
      ok: true,
      result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: false },
    }),
  });
  await wait(400);
  page.adapter.markActivity();
  const two = [call('echo IMG_A'), call('echo IMG_B')].map((c) => JSON.stringify(c)).join('\n');
  page.append(claudeTurn('user', '<p>two images</p>') + claudeTurn('assistant', `<pre>${two}</pre>`));
  await wait(2600);
  await scan(page, 10);
  assert.deepEqual(page.ran, ['echo IMG_A', 'echo IMG_B'], 'both calls ran');
  assert.equal(page.sent.length, 1, 'one result message');
  assert.equal((page.sent[0].match(/\[MCP_RESULT/g) ?? []).length, 2, 'two result blocks');
  assert.ok(page.sent[0].includes('terminal_run_command_1_1.png'), 'the first result names its own attachment');
  assert.ok(page.sent[0].includes('terminal_run_command_2_1.png'), 'the second result names a different attachment');
  page.stop();
}

// ───────────── 8. A result of the PREVIOUS turn is not delivered after a new turn ─────────────
{
  let release = null;
  const page = load({}, {
    onCall: () => new Promise((resolve) => {
      release = () => resolve({ ok: true, result: { content: [{ type: 'text', text: 'late old result' }] } });
    }),
  });
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>first</p>') + claudeTurn('assistant', `<pre>${JSON.stringify(call('echo OLD_TURN'))}</pre>`));
  await wait(2600);
  await scan(page, 6);
  assert.deepEqual(page.ran, ['echo OLD_TURN'], 'the old call is running');
  // The user starts a NEW turn while the tool is still running.
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>second</p>') + claudeTurn('assistant', '<p>new turn</p>'));
  await scan(page, 2);
  release?.();
  await wait(800);
  await scan(page, 6);
  assert.equal(page.sent.length, 0, 'the old result is NOT typed into the new turn');
  page.stop();
}

// ───────────── 9. A call inside a result the extension wrote is data, never a request ─────────────
{
  const page = load({});
  await wait(400);
  page.adapter.markActivity();
  const injected = { mcp_call: { server: 'terminal', name: 'run_command', arguments: { command: 'echo FROM_RESULT' } } };
  const resultLike = `[MCP_RESULT server="terminal" tool="run_command" status="ok"]\n${JSON.stringify(injected)}\n[/MCP_RESULT]`;
  page.append(claudeTurn('user', '<p>go</p>') + claudeTurn('assistant', `<pre>${resultLike}</pre>`));
  await wait(2600);
  await scan(page, 8);
  assert.deepEqual(page.ran, [], 'a call quoted inside [MCP_RESULT] is not executed');
  assert.equal(page.sent.length, 0, 'and nothing is written back');
  page.stop();
}

// ───────────── 10. A pending call is NOT resumed after the user started a newer turn ─────────────
{
  const storage = {};
  const oldTurn = claudeTurn('user', '<p>first</p>')
    + claudeTurn('assistant', `<pre>${JSON.stringify(call('echo STALE_PENDING'))}</pre>`);
  const first = load(storage, { history: '' });
  await wait(400);
  first.context.WMB.waitFor = async (fn) => fn() || false; // the chat refuses the result
  first.adapter.submit = async () => false;
  first.adapter.markActivity();
  first.append(oldTurn);
  await wait(2600);
  await scan(first, 8);
  assert.deepEqual(first.ran, ['echo STALE_PENDING'], 'the call ran before the reload');
  assert.ok(!storage['wmb:delivered'], 'its result was never delivered');
  first.stop();

  // Reload: the conversation now has a NEWER user turn after the call — the old result is stale.
  const second = load(storage, { history: `${oldTurn}${claudeTurn('user', '<p>a newer question</p>')}` });
  await wait(3000);
  await scan(second, 10);
  assert.deepEqual(second.ran, [], 'a pending result of an older turn is NOT run again after a reload');
  assert.equal(second.sent.length, 0, 'and nothing is delivered late');
  second.stop();
}

console.log('✔ test_delivery_audit: content, report, cross-chat history, staged delivery, no-request, batch-isolation and stale-pending regressions passed');
process.exit(0); // the observers of the jsdom pages keep the event loop alive
