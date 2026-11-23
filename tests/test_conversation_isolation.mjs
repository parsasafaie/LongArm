/**
 * test_conversation_isolation.mjs — one request, one execution, one delivery, in the RIGHT conversation.
 *
 * The bug these guard: navigating (opening a chat from outside it, switching chats, a reload) used to make the
 * extension treat restored history as a live request — the same `mcp_call` ran again, or a result from the chat
 * that asked was typed into whatever conversation was on screen.
 *
 * Drives the REAL content scripts against a ChatGPT-like page in jsdom. Every scenario asserts on what ran and
 * what was written into the chat, which is exactly the user-visible symptom.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../package.json', import.meta.url));
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch {
  // jsdom is a devDependency: a missing install is a broken test environment, not a reason to report green.
  console.error('✘ test_conversation_isolation needs jsdom: run `npm install`');
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
  'content_scripts/adapters/claude.js',
  'content_scripts/core_bridge.js',
];

const call = (cmd) => ({ mcp_call: { server: 'terminal', name: 'run_command', arguments: { command: cmd } } });
const block = (...calls) => calls.map((c) => `<pre><code class="language-json">${JSON.stringify(c)}</code></pre>`).join('\n');
const multiBlock = (...calls) => `<pre><code class="language-json">${calls.map((c) => JSON.stringify(c)).join('\n')}</code></pre>`;
const turn = (role, inner) => `<article data-turn="${role}"><div data-message-author-role="${role}"><div class="markdown prose">${inner}</div></div></article>`;
const shell = (thread) => `<!doctype html><html><body><main><div class="thread">${thread}</div></main>
<form><div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"></div>
<button data-testid="send-button" aria-label="Send prompt">Send</button></form></body></html>`;

// ───────────── The base-adapter hosts (Gemini / Claude / DeepSeek) ─────────────
// They have NO text-located block scan and no positional guard of its own: their restored history is exactly
// what used to execute on navigation. Claude's selectors are the simplest to reproduce faithfully.
const claudeTurn = (role, inner) => (role === 'user'
  ? `<div data-testid="user-message">${inner}</div>`
  : `<div class="font-claude-response">${inner}</div>`);
const claudeShell = (thread) => `<!doctype html><html><body><main><div class="thread">${thread}</div></main>
<fieldset><div contenteditable="true" class="ProseMirror"></div></fieldset></body></html>`;

/** One page load. `storage` is the sessionStorage shared across reloads of the SAME tab. */
function load(storage, { url = 'https://chatgpt.com/c/chat-a', history = '', onCall, site = 'chatgpt', autoSend = true, permission = 'allow', bridgeEnabled = true, setup, claims = null } = {}) {
  const claude = site === 'claude';
  const dom = new JSDOM(claude ? claudeShell(history) : shell(history), { url });
  const { window } = dom;
  const ran = [];
  const sent = [];
  const session = {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  const context = vm.createContext({
    console, setTimeout, clearTimeout, Date, JSON, Set, Map, WeakMap, Promise, Math,
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

  const servers = [{ id: 's1', slug: 'terminal', name: 'terminal', url: 'ws://x', enabled: true, permission, status: 'connected' }];
  const tools = [{ server: 'terminal', name: 'run_command', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } }];
  context.chrome = {
    runtime: {
      id: 'ext',
      onMessage: { addListener: () => {} },
      sendMessage: async (m) => {
        if (m.type === 'GET_STATE') return { ok: true, epoch: 1, settings: { bridgeEnabled, autoSend, maxResultChars: 12000, hideProtocol: false, focusFallback: false }, servers };
        if (m.type === 'GET_ACTIVE_TOOLS') return { ok: true, tools, guides: {} };
        if (m.type === 'CLAIM_CALL') {
          if (!claims) return { ok: true, fresh: true };
          const owner = claims.get(m.key);
          if (owner && owner !== m.tab_id) return { ok: true, fresh: false };
          claims.set(m.key, m.tab_id);
          return { ok: true, fresh: true };
        }
        if (m.type === 'CALL_TOOL') {
          ran.push(m.arguments?.command ?? m.name);
          return onCall ? onCall(m) : { ok: true, result: { content: [{ type: 'text', text: `out:${m.arguments?.command}` }] } };
        }
        return { ok: true };
      },
    },
  };

  for (const file of SCRIPTS) {
    // A hook between the widget/adapters and the controller: lets a test stub the approval dialog.
    if (file.endsWith('core_bridge.js') && setup) setup(context.WMB, context);
    vm.runInContext(read(file), context);
  }
  const WMB = context.WMB;
  WMB.isVisible = () => true;
  // A composer that really holds the text: draft/staged logic and duplicate delivery depend on reading it back.
  WMB.dom.setText = async (el, text, { append = true } = {}) => {
    sent.push(text);
    el.textContent = append && el.textContent ? `${el.textContent}\n${text}` : text;
    return true;
  };
  WMB.dom.clearText = async (el) => { if (el) el.textContent = ''; };
  WMB.waitFor = async (fn) => fn() || true;
  const adapter = WMB.findAdapter(claude ? 'claude.ai' : 'chatgpt.com');
  adapter.submit = async () => true;

  /** The navigation a site does without a reload: another URL, same page. */
  const navigate = (nextUrl, nextThread) => {
    const next = new URL(nextUrl);
    window.history.pushState({}, '', next.pathname + next.search);
    const thread = window.document.querySelector('.thread');
    thread.innerHTML = nextThread ?? '';
  };

  /** The site assigns the real URL to the chat that is ALREADY rendered: the DOM stays the same. */
  const assignUrl = (nextUrl) => {
    const next = new URL(nextUrl);
    window.history.pushState({}, '', next.pathname + next.search);
  };

  const append = (html) => window.document.querySelector('.thread').insertAdjacentHTML('beforeend', html);
  return { adapter, ran, sent, doc: window.document, context, navigate, assignUrl, append, stop: () => { WMB.started = false; } };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const scan = async (page, rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) { await wait(350); page.adapter.rescan?.(); }
};

/** `ONLY=n` runs a single scenario (used to isolate a failure while developing the suite). */
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const pending = [];
const scenario = (n, fn) => { if (ONLY && !ONLY.has(String(n))) return; pending.push(Promise.resolve().then(fn)); };


/** Runs one call live, the way a user's send does. Returns nothing; assertions read `ran`/`sent`. */
async function runLive(page, html, cmd) {
  await wait(400);
  page.adapter.markActivity();
  page.append(html);
  await wait(2200);
  await scan(page, 10);
}

// ───────────── 1. Switching between two chats ─────────────
scenario(1, async () => {
  const storage = {};
  const a = turn('user', '<p>a</p>') + turn('assistant', block(call('LONGARM_TEST_1')));
  const b = turn('user', '<p>b</p>') + turn('assistant', block(call('LONGARM_TEST_2')));

  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: a });
  await wait(3000); // chat A restored: history, nothing runs
  assert.deepEqual(page.ran, [], 'opening chat A runs nothing');

  await runLive(page, '', null); // no-op settle
  page.ran.length = 0;
  page.sent.length = 0;

  // Live call in chat A, delivered.
  page.navigate('https://chatgpt.com/c/chat-a', a);
  await wait(400);
  page.adapter.markActivity();
  page.append(turn('user', '<p>more</p>') + turn('assistant', block(call('AAA'))));
  await wait(2200);
  await scan(page, 10);
  assert.deepEqual(page.ran, ['AAA'], 'the live call in chat A runs once');
  assert.equal(page.sent.length, 1, 'and is delivered once');

  // Switch to chat B: its own history must not run, and chat A's ledger must not leak into it.
  page.navigate('https://chatgpt.com/c/chat-b', b);
  await scan(page, 12);
  assert.deepEqual(page.ran, ['AAA'], 'switching to chat B runs nothing of its restored history');
  assert.equal(page.sent.length, 1, 'and delivers nothing into chat B');

  // Back to chat A, still nothing.
  page.navigate('https://chatgpt.com/c/chat-a', a);
  await scan(page, 12);
  assert.deepEqual(page.ran, ['AAA'], 'returning to chat A runs nothing again');
  assert.equal(page.sent.length, 1, 'and delivers nothing again');
  page.stop();
});

// ───────────── 2. Opening an existing chat from outside the current chat ─────────────
scenario(2, async () => {  const storage = {};
  const other = turn('user', '<p>x</p>') + turn('assistant', block(call('df -h /')));
  const page = load(storage, { url: 'https://chatgpt.com/', history: '' });
  await wait(2600);
  assert.deepEqual(page.ran, [], 'the empty new chat runs nothing');

  // Opening a chat from the sidebar: the DOM is replaced with a conversation that has historical calls.
  page.navigate('https://chatgpt.com/c/opened', other);
  await scan(page, 14);
  assert.deepEqual(page.ran, [], 'opening an existing chat from outside it executes NOT its historical call');
  assert.equal(page.sent.length, 0, 'and writes nothing into that chat');
  page.stop();
});

// ───────────── 3. Refreshing the page ─────────────
scenario(3, async () => {  const storage = {};
  const history = turn('user', '<p>run</p>') + turn('assistant', block(call('pwd')));
  const first = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '' });
  await runLive(first, turn('user', '<p>run</p>') + turn('assistant', block(call('pwd'))), 'pwd');
  assert.deepEqual(first.ran, ['pwd'], 'the call runs once before the refresh');
  assert.equal(first.sent.length, 1, 'and is delivered once');

  const second = load(storage, { url: 'https://chatgpt.com/c/chat-a', history });
  await wait(3000);
  await scan(second, 12);
  assert.deepEqual(second.ran, [], 'a refresh re-runs nothing');
  assert.equal(second.sent.length, 0, 'a refresh re-delivers nothing');
  second.stop();
});

// ───────────── 4. Reconnecting WebSocket ─────────────
scenario(4, async () => {  const storage = {};
  let down = true;
  const page = load(storage, {
    url: 'https://chatgpt.com/c/chat-a',
    onCall: () => (down ? { ok: false, error: 'not connected' } : { ok: true, result: { content: [{ type: 'text', text: 'up' }] } }),
  });
  await wait(400);
  page.adapter.markActivity();
  page.append(turn('user', '<p>go</p>') + turn('assistant', block(call('whoami'))));
  await wait(2200);
  await Promise.race([scan(page, 10), wait(7000)]);
  assert.ok(page.ran.length >= 1, 'the call is attempted while the socket is down');
  assert.ok(page.sent.length <= 1, 'a reconnecting socket delivers at most one result per call');
  down = false;
  const before = page.sent.length;
  await scan(page, 10);
  assert.equal(page.sent.length, before, 'the reconnect itself triggers no second delivery');
  page.stop();
});

// ───────────── 5. Navigating while a request is running ─────────────
scenario(5, async () => {  const storage = {};
  let release = null;
  const page = load(storage, {
    url: 'https://chatgpt.com/c/chat-a',
    onCall: (m) => new Promise((resolve) => { release = () => resolve({ ok: true, result: { content: [{ type: 'text', text: `done:${m.arguments.command}` }] } }); }),
  });
  await wait(400);
  page.adapter.markActivity();
  page.append(turn('user', '<p>slow</p>') + turn('assistant', block(call('sleep 5'))));
  await wait(2200);
  page.adapter.rescan?.();

  // The user leaves for another chat while the tool runs.
  page.navigate('https://chatgpt.com/c/chat-b', turn('user', '<p>b</p>') + turn('assistant', '<p>hi</p>'));
  await scan(page, 4);
  if (release) release();
  await wait(1200);
  await scan(page, 8);

  assert.equal(page.sent.length, 0, 'a result whose conversation is no longer on screen is NOT typed into the new chat');
  assert.ok(page.ran.length >= 1, 'the call itself did run');
  page.stop();
});

// ───────────── 6. Navigating after a request has completed ─────────────
scenario(6, async () => {  const storage = {};
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '' });
  await runLive(page, turn('user', '<p>one</p>') + turn('assistant', block(call('echo 1'))), 'echo 1');
  assert.deepEqual(page.ran, ['echo 1'], 'the call completed once');
  assert.equal(page.sent.length, 1, 'and was delivered once');

  const a = turn('user', '<p>one</p>') + turn('assistant', block(call('echo 1')));
  // The chat is revisited: the completed call is history, not a new request.
  page.navigate('https://chatgpt.com/c/chat-a', a);
  await scan(page, 14);
  assert.deepEqual(page.ran, ['echo 1'], 'a completed call does not run again on return');
  assert.equal(page.sent.length, 1, 'and is not delivered again');
  page.stop();
});

// ───────────── 7. Multiple tool calls in one assistant message ─────────────
scenario(7, async () => {  const storage = {};
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '' });
  await runLive(page, turn('user', '<p>batch</p>') + turn('assistant', multiBlock(call('echo a'), call('echo b'), call('echo c'))), null);
  assert.deepEqual(page.ran, ['echo a', 'echo b', 'echo c'], 'each call of the batch runs once, in order');
  assert.equal(page.sent.length, 1, 'the batch is delivered in ONE message');
  assert.equal((page.sent[0].match(/\[MCP_RESULT/g) ?? []).length, 3, 'with one result block per call');
  page.stop();
});

// ───────────── 8. Duplicate events with the same request ID ─────────────
scenario(8, async () => {  const storage = {};
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '' });
  await wait(400);
  page.adapter.markActivity();
  const html = turn('user', '<p>dup</p>') + turn('assistant', block(call('echo dup')));
  page.append(html);
  await wait(2200);
  // Several scans while the same block is on the page: one id, one execution, one delivery.
  await scan(page, 14);
  assert.deepEqual(page.ran, ['echo dup'], 'a duplicate detection of the same call runs it once');
  assert.equal(page.sent.length, 1, 'and delivers once');
  // A re-render of the whole thread must still not re-fire it.
  page.doc.querySelector('.thread').innerHTML = html;
  await scan(page, 10);
  assert.deepEqual(page.ran, ['echo dup'], 'a repaint of the executed message does not run it again');
  assert.equal(page.sent.length, 1, 'and does not deliver again');
  page.stop();
});

// ───────────── 9. Result arriving after switching to another chat ─────────────
scenario(9, async () => {  const storage = {};
  let release = null;
  const page = load(storage, {
    url: 'https://chatgpt.com/c/chat-a',
    onCall: () => new Promise((resolve) => { release = () => resolve({ ok: true, result: { content: [{ type: 'text', text: 'late' }] } }); }),
  });
  await wait(400);
  page.adapter.markActivity();
  page.append(turn('user', '<p>x</p>') + turn('assistant', block(call('late'))));
  await wait(2200);
  page.adapter.rescan?.();
  assert.ok(page.ran.length >= 1, 'the request started');

  const b = turn('user', '<p>b</p>') + turn('assistant', block(call('unrelated')));
  page.navigate('https://chatgpt.com/c/chat-b', b);
  await scan(page, 3);
  if (release) release();
  await scan(page, 10);

  assert.equal(page.sent.length, 0, 'the late result is never written into chat B');
  assert.deepEqual(page.ran, ['late'], 'chat B\'s own historical call did not execute either');
  page.stop();
});

// ───────────── 10. Restoring a chat containing historical tool calls ─────────────
scenario(10, async () => {
  const storage = {};
  const history = [
    turn('user', '<p>first</p>'),
    turn('assistant', block(call('LONGARM_TEST_1'))),
    turn('user', '<p>second</p>'),
    turn('assistant', block(call('LONGARM_TEST_2'))),
    turn('user', '<p>third</p>'),
    turn('assistant', multiBlock(call('df -h /'), call('uname -a'))),
  ].join('');
  const page = load(storage, { url: 'https://chatgpt.com/c/history', history });
  await wait(3200);
  await scan(page, 14);
  assert.deepEqual(page.ran, [], 'restoring a chat with historical tool calls executes none of them');
  assert.equal(page.sent.length, 0, 'and writes no result into the restored conversation');
  page.stop();
});


// ───────────── 11. Base adapter (Claude/Gemini/DeepSeek): restored history never fires ─────────────
scenario(11, async () => {
  const storage = {};
  const history = [
    claudeTurn('user', '<p>first</p>'),
    claudeTurn('assistant', block(call('LONGARM_TEST_1'))),
    claudeTurn('user', '<p>second</p>'),
    claudeTurn('assistant', multiBlock(call('LONGARM_TEST_2'), call('df -h /'))),
  ].join('');
  const page = load(storage, { site: 'claude', url: 'https://claude.ai/chat/abc', history });
  await wait(3400);
  await scan(page, 14);
  assert.deepEqual(page.ran, [], 'base adapter: a restored chat executes none of its historical calls');
  assert.equal(page.sent.length, 0, 'base adapter: and writes nothing into the chat');
  page.stop();
});

// ───────────── 12. Base adapter: switching chats does not run the owner chat's calls ─────────────
scenario(12, async () => {
  const storage = {};
  const chatA = [
    claudeTurn('user', '<p>a</p>'),
    claudeTurn('assistant', block(call('AAA'))),
  ].join('');
  const chatB = [
    claudeTurn('user', '<p>b</p>'),
    claudeTurn('assistant', block(call('BBB'))),
  ].join('');
  const page = load(storage, { site: 'claude', url: 'https://claude.ai/chat/a', history: chatA });
  await scan(page, 10);
  assert.deepEqual(page.ran, [], 'base adapter: opening chat A runs nothing');

  page.navigate('https://claude.ai/chat/b', chatB);
  await scan(page, 12);
  assert.deepEqual(page.ran, [], 'base adapter: switching to chat B runs nothing');
  assert.equal(page.sent.length, 0, 'base adapter: switching to chat B delivers nothing');
  page.stop();
});

// ───────────── 13. Base adapter: a real send still runs the call exactly once ─────────────
scenario(13, async () => {
  const storage = {};
  const page = load(storage, { site: 'claude', url: 'https://claude.ai/chat/a', history: '' });
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>go</p>') + claudeTurn('assistant', block(call('echo live'))));
  await wait(2600);
  await scan(page, 12);
  assert.deepEqual(page.ran, ['echo live'], 'base adapter: a live call runs once');
  assert.equal(page.sent.length, 1, 'base adapter: and is delivered once');
  page.stop();
});


// ───────────── 14. Three separate call blocks in ONE reply (the reported bug) ─────────────
scenario(14, async () => {
  const storage = {};
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '' });
  await wait(400);
  page.adapter.markActivity();
  // Three SEPARATE <pre> blocks (not one block with three calls): A, B and C.
  page.append(turn('user', '<p>three</p>') + turn('assistant', [
    block(call('echo BATCH_REQUEST_A && hostname')),
    block(call('echo BATCH_REQUEST_B && whoami')),
    block(call('echo BATCH_REQUEST_C && cd')),
  ].join('')));
  await wait(2400);
  await scan(page, 12);
  assert.deepEqual(page.ran, [
    'echo BATCH_REQUEST_A && hostname',
    'echo BATCH_REQUEST_B && whoami',
    'echo BATCH_REQUEST_C && cd',
  ], 'all three separate call blocks of one reply execute, in order');
  assert.equal(page.sent.length, 1, 'their results travel in one message');
  assert.equal((page.sent[0].match(/\[MCP_RESULT/g) ?? []).length, 3, 'and no result is overwritten: one block per call');
  assert.ok(page.sent[0].includes('out:echo BATCH_REQUEST_A'), 'result of A is present');
  assert.ok(page.sent[0].includes('out:echo BATCH_REQUEST_B'), 'result of B is present');
  assert.ok(page.sent[0].includes('out:echo BATCH_REQUEST_C'), 'result of C is present');
  page.stop();
});

// ───────────── 15. Same, on the base adapter (separate messages are not required) ─────────────
scenario(15, async () => {
  const storage = {};
  const page = load(storage, { site: 'claude', url: 'https://claude.ai/chat/a', history: '' });
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>three</p>') + claudeTurn('assistant', multiBlock(call('A'), call('B'), call('C'))));
  await wait(2600);
  await scan(page, 12);
  assert.deepEqual(page.ran, ['A', 'B', 'C'], 'base adapter: all three calls of one message execute');
  assert.equal((page.sent[0]?.match(/\[MCP_RESULT/g) ?? []).length, 3, 'base adapter: three result blocks, none overwritten');
  page.stop();
});

// ───────────── 16. ChatGPT: a FIRST reply with 3 separate blocks gets its /c/<id> ─────────────
scenario(16, async () => {
  const storage = {};
  let release = null;
  let held = false;
  let released = false;
  const ok = () => ({ ok: true, result: { content: [{ type: 'text', text: 'ok' }] } });
  const page = load(storage, {
    url: 'https://chatgpt.com/',
    history: '',
    onCall: () => {
      if (held || released) return ok();
      held = true; // hold only the first call, so the URL can arrive while the batch runs
      return new Promise((resolve) => { release = () => { released = true; resolve(ok()); }; });
    },
  });
  await wait(400);
  page.adapter.markActivity();
  const html = turn('user', '<p>three</p>') + turn('assistant', [
    block(call('echo NEW_A')),
    block(call('echo NEW_B')),
    block(call('echo NEW_C')),
  ].join(''));
  page.append(html);
  await wait(1600); // the reply is stable and the first call is detected/running
  await scan(page, 3);
  assert.ok(page.ran.length >= 1, 'the first call started in the new chat');
  // The first reply assigns the chat its URL while the calls run: the SAME conversation, not a navigation.
  page.assignUrl('https://chatgpt.com/c/new-chat');
  release?.();
  await wait(1200);
  await scan(page, 12);
  assert.deepEqual(page.ran, ['echo NEW_A', 'echo NEW_B', 'echo NEW_C'], '3-block first reply: all three calls run');
  assert.equal(page.sent.length, 1, '3-block first reply: all results are delivered in ONE message');
  assert.equal((page.sent[0].match(/\[MCP_RESULT/g) ?? []).length, 3, 'and no result is lost');
  page.stop();
});

// ───────────── 17. Claude: /new → /chat/<id> is the same conversation ─────────────
scenario(17, async () => {
  const storage = {};
  let release = null;
  const page = load(storage, {
    site: 'claude',
    url: 'https://claude.ai/new',
    history: '',
    onCall: () => new Promise((resolve) => { release = () => resolve({ ok: true, result: { content: [{ type: 'text', text: 'ok' }] } }); }),
  });
  await wait(400);
  page.adapter.markActivity();
  const html = claudeTurn('user', '<p>go</p>') + claudeTurn('assistant', block(call('echo CLAUDE')));
  page.append(html);
  await wait(2600);
  await scan(page, 3);
  assert.ok(page.ran.length >= 1, 'the call started in the new chat');
  page.assignUrl('https://claude.ai/chat/abc'); // the URL arrives while the tool runs; the DOM stays
  release?.();
  await wait(1200);
  await scan(page, 12);
  assert.deepEqual(page.ran, ['echo CLAUDE'], 'Claude /new → /chat/<id>: the call runs once');
  assert.equal(page.sent.length, 1, 'Claude /new → /chat/<id>: the result is NOT dropped');
  page.stop();
});

// ───────────── 18. Delivery failure + re-render in the SAME page: run once, retry only on reload ─────────────
scenario(18, async () => {
  const storage = {};
  const html = turn('user', '<p>run</p>') + turn('assistant', block(call('echo FAILED_DELIVERY')));
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '' });
  await wait(400);
  // The chat does not accept the result: submit and the send confirmation both fail. Armed BEFORE the
  // call is detected, or the result would be delivered successfully during the settle wait.
  page.context.WMB.waitFor = async (fn) => fn() || false;
  page.adapter.submit = async () => false;
  page.adapter.markActivity();
  page.append(html);
  await wait(2200);
  await scan(page, 10);
  assert.deepEqual(page.ran, ['echo FAILED_DELIVERY'], 'the call ran once');
  assert.ok(!storage['wmb:delivered'], 'the failed delivery is NOT recorded as delivered');

  // React re-mounts the same assistant message in the same page load: it must not run again.
  page.doc.querySelector('.thread').innerHTML = html;
  await scan(page, 12);
  assert.deepEqual(page.ran, ['echo FAILED_DELIVERY'], 'a same-page re-render after a failed delivery does NOT re-run the tool');

  // A real reload is the ONE place a pending call may run again (the AI never got its result).
  const reload = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: html });
  await wait(3000);
  await scan(reload, 12);
  assert.deepEqual(reload.ran, ['echo FAILED_DELIVERY'], 'a reload retries the pending call exactly once');
  page.stop(); reload.stop();
});

// ───────────── 19. autoSend=false: staged is not delivered ─────────────
scenario(19, async () => {
  const storage = {};
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '', autoSend: false });
  await wait(400);
  page.adapter.markActivity();
  page.append(turn('user', '<p>run</p>') + turn('assistant', block(call('echo STAGED'))));
  await wait(2200);
  await scan(page, 10);
  assert.deepEqual(page.ran, ['echo STAGED'], 'the call runs');
  assert.equal(page.sent.length, 1, 'the result is written into the composer');
  assert.ok(storage['wmb:executed'], 'the call is remembered as fired');
  assert.ok(!storage['wmb:delivered'], 'but NOT as delivered: nothing was sent yet');
  // The user presses Enter themselves: a trusted send event while the staged text is still in the composer,
  // then the composer clears and the chat starts generating.
  page.adapter.markActivity();
  page.doc.querySelector('#prompt-textarea').textContent = '';
  page.doc.body.insertAdjacentHTML('beforeend', '<button data-testid="stop-button">stop</button>');
  await scan(page, 3);
  assert.ok(storage['wmb:delivered'], 'a manual send of the staged result marks it delivered');
  page.stop();
});

// ───────────── 20. deny produces the protocol status `rejected`, not `error` ─────────────
scenario(20, async () => {
  const storage = {};
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '', permission: 'deny' });
  await wait(400);
  page.adapter.markActivity();
  page.append(turn('user', '<p>run</p>') + turn('assistant', block(call('echo DENIED'))));
  await wait(2200);
  await scan(page, 10);
  assert.deepEqual(page.ran, [], 'a denied server runs nothing');
  assert.equal(page.sent.length, 1, 'the refusal still reaches the AI');
  assert.match(page.sent[0], /status="rejected"/, 'and carries status="rejected" (the protocol status)');
  page.stop();
});

// ───────────── 21. Four identical calls in one batch: every call gets an answer ─────────────
scenario(21, async () => {
  const storage = {};
  // A real claim table: the four identical calls are all from THIS tab, so the registry (not the claim)
  // decides what happens to the duplicates.
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '', claims: new Map() });
  await wait(400);
  page.adapter.markActivity();
  const same = call('echo SAME');
  page.append(turn('user', '<p>run</p>') + turn('assistant', multiBlock(same, same, same, same)));
  await wait(2200);
  await scan(page, 12);
  assert.deepEqual(page.ran, ['echo SAME'], 'only the first identical call runs');
  assert.equal(page.sent.length, 1, 'one result message');
  assert.equal((page.sent[0].match(/\[MCP_RESULT/g) ?? []).length, 4, 'all FOUR calls get a result block (none silently dropped)');
  page.stop();
});

// ───────────── 22. ask: a repeated identical call replays the refusal (no second dialog) ─────────────
scenario(22, async () => {
  const storage = {};
  let prompts = 0;
  const page = load(storage, {
    url: 'https://chatgpt.com/c/chat-a',
    history: '',
    permission: 'ask',
    setup(WMB) { WMB.Widget.prototype.requestApproval = async () => { prompts += 1; return false; }; },
  });
  await wait(400);
  page.adapter.markActivity();
  const same = call('echo ASK');
  page.append(turn('user', '<p>run</p>') + turn('assistant', multiBlock(same, same)));
  await wait(2200);
  await scan(page, 10);
  assert.equal(prompts, 1, 'the user is asked once for two identical calls');
  assert.deepEqual(page.ran, [], 'a refusal runs nothing');
  assert.equal((page.sent[0]?.match(/status="rejected"/g) ?? []).length, 2, 'both calls receive the SAME refusal');
  page.stop();
});

// ───────────── 23. ChatGPT: an unreadable block warns the AI (format_error) ─────────────
scenario(23, async () => {
  const storage = {};
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '' });
  await wait(400);
  page.adapter.markActivity();
  const broken = '<pre><code class="language-json">{"mcp_call":{"server":"terminal","name":"run_command","arguments":{"command":"echo broken"</code></pre>';
  page.append(turn('user', '<p>run</p>') + turn('assistant', broken));
  await wait(2600);
  await scan(page, 10);
  assert.equal(page.sent.length, 1, 'ChatGPT now sends the format warning');
  assert.match(page.sent[0], /status="format_error"/);
  page.stop();
});

// ───────────── 24. A queued malformed notice is written to the conversation that asked, never the new one ─────────────
scenario(24, async () => {
  const storage = {};
  let releaseApproval = null;
  const page = load(storage, {
    url: 'https://chatgpt.com/c/chat-a',
    history: '',
    permission: 'ask',
    setup(WMB) {
      WMB.Widget.prototype.requestApproval = () => new Promise((resolve) => { releaseApproval = () => resolve(false); });
    },
  });
  await wait(400);
  page.adapter.markActivity();
  // A call waiting for approval blocks the serial queue.
  page.append(turn('user', '<p>one</p>') + turn('assistant', block(call('echo BLOCKED'))));
  await wait(2600);
  assert.ok(releaseApproval, 'the approval dialog is open');
  // While it waits, the AI sends an unreadable block: that detection is queued behind the approval.
  const broken = '<pre><code>{"mcp_call":{"server":"terminal","name":"run_command","arguments":{"command":"echo broken"</code></pre>';
  page.append(turn('assistant', broken));
  await wait(1500);
  // The user leaves for chat B before answering.
  page.navigate('https://chatgpt.com/c/chat-b', turn('user', '<p>b</p>') + turn('assistant', '<p>hi</p>'));
  await scan(page, 4);
  releaseApproval();
  await wait(1500);
  await scan(page, 10);
  assert.equal(page.sent.length, 0, 'neither the refusal nor the format_error is typed into chat B');
  page.stop();
});

// ───────────── 25. list_tools: ONE format for the single call and for a batch ─────────────
const listCall = { mcp_call: { server: 'bridge', name: 'list_tools', arguments: {} } };
scenario(25, async () => {
  const storage = {};
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '' });
  await wait(400);
  page.adapter.markActivity();
  page.append(turn('user', '<p>tools</p>') + turn('assistant', block(listCall)));
  await wait(2200);
  await scan(page, 10);
  assert.equal(page.sent.length, 1, 'the tool list is delivered');
  assert.match(page.sent[0], /run_command/, 'with the active tools');
  assert.ok(!page.sent[0].includes('"request_id"'), 'as PLAIN text, not as a lifecycle JSON');
  page.stop();
});

scenario(26, async () => {
  const storage = {};
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '' });
  await wait(400);
  page.adapter.markActivity();
  page.append(turn('user', '<p>tools + echo</p>') + turn('assistant', multiBlock(listCall, call('echo WITH_LIST'))));
  await wait(2200);
  await scan(page, 10);
  assert.deepEqual(page.ran, ['echo WITH_LIST'], 'the real call in the batch runs');
  assert.equal((page.sent[0]?.match(/\[MCP_RESULT/g) ?? []).length, 2, 'two result blocks');
  assert.match(page.sent[0], /run_command/, 'the batch list_tools has the SAME plain format');
  page.stop();
});

// ───────────── 27. The batch has a total time budget (R-04) ─────────────
scenario(27, async () => {
  const storage = {};
  const page = load(storage, {
    url: 'https://chatgpt.com/c/chat-a',
    history: '',
    permission: 'ask',
    setup(WMB) { WMB.defaults.timeouts.queue = 250; }, // tiny budget for the test
  });
  await wait(400);
  page.adapter.markActivity();
  page.append(turn('user', '<p>slow approval</p>') + turn('assistant', multiBlock(call('echo FIRST'), call('echo SECOND'))));
  await wait(2200);
  await scan(page, 14);
  assert.equal((page.sent[0]?.match(/\[MCP_RESULT/g) ?? []).length, 2, 'both calls still get an answer');
  assert.match(page.sent[0], /queue time budget/i, 'the call past the budget is reported, not silently dropped');
  page.stop();
});

// ───────────── 28. Two tabs on the same conversation run the same call only ONCE (R-01) ─────────────
scenario(28, async () => {
  const claims = new Map(); // the service worker's cross-tab claim table (key → tab id)
  const a = load({}, { url: 'https://chatgpt.com/c/shared', history: '', claims });
  const b = load({}, { url: 'https://chatgpt.com/c/shared', history: '', claims });
  await wait(400);
  a.adapter.markActivity();
  b.adapter.markActivity();
  const html = turn('user', '<p>two tabs</p>') + turn('assistant', block(call('echo ONE_TAB')));
  a.append(html);
  b.append(html);
  await wait(2400);
  await Promise.all([scan(a, 10), scan(b, 10)]);
  assert.equal(a.ran.length + b.ran.length, 1, 'the call ran in exactly one tab');
  const allSent = [...a.sent, ...b.sent];
  assert.ok(allSent.some((text) => text.includes('ONE_TAB')), 'the winning tab delivers the real result');
  assert.ok(allSent.some((text) => /another tab/i.test(text)), 'the losing tab gets an explicit answer, not silence');
  a.stop(); b.stop();
});

// ───────────── 29. A reply that GROWS after the call ran must not fire it again (RES-01) ─────────────
scenario(29, async () => {
  const storage = {};
  const page = load(storage, { site: 'claude', url: 'https://claude.ai/chat/a', history: '' });
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>go</p>') + claudeTurn('assistant', block(call('echo GROW'))));
  await wait(2600);
  await scan(page, 10);
  assert.deepEqual(page.ran, ['echo GROW'], 'the call ran once');
  assert.equal(page.sent.length, 1, 'and was delivered once');
  // The model (or a renderer) adds prose AFTER the call in the same assistant message.
  page.doc.querySelector('.font-claude-response').insertAdjacentHTML('beforeend', '<p>More explanation after the call.</p>');
  await scan(page, 12);
  assert.deepEqual(page.ran, ['echo GROW'], 'text growth does NOT run the tool again');
  assert.equal(page.sent.length, 1, 'and does NOT deliver a second result');
  page.stop();
});

// ───────────── 30. URL arrives AFTER detection: one delivery (RES-03) ─────────────
scenario(30, async () => {
  const storage = {};
  let release = null;
  const page = load(storage, {
    site: 'claude',
    url: 'https://claude.ai/new',
    history: '',
    onCall: () => new Promise((resolve) => { release = () => resolve({ ok: true, result: { content: [{ type: 'text', text: 'late ok' }] } }); }),
  });
  await wait(400);
  page.adapter.markActivity();
  const html = claudeTurn('user', '<p>go</p>') + claudeTurn('assistant', block(call('echo LATE_URL')));
  page.append(html);
  await wait(2600);
  await scan(page, 6);
  assert.ok(page.ran.length >= 1, 'the call started before the URL existed');
  page.assignUrl('https://claude.ai/chat/abc'); // the URL arrives during the tool run; the DOM stays
  await scan(page, 3);
  release?.();
  await wait(1200);
  await scan(page, 10);
  assert.equal(page.sent.length, 1, 'the result is delivered exactly once, not again from the new id');
  page.stop();
});

// ───────────── 31. Two NEW chats: the result of A never lands in B (RES-02) ─────────────
scenario(31, async () => {
  const storage = {};
  let release = null;
  const page = load(storage, {
    site: 'claude',
    url: 'https://claude.ai/new',
    history: '',
    onCall: () => new Promise((resolve) => { release = () => resolve({ ok: true, result: { content: [{ type: 'text', text: 'A result' }] } }); }),
  });
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>A</p>') + claudeTurn('assistant', block(call('echo CHAT_A'))));
  await wait(2600);
  await scan(page, 6);
  assert.ok(page.ran.length >= 1, 'the call of chat A started');
  // A NEW chat B in the same tab: empty thread, user sends, B gets its own URL.
  page.doc.querySelector('.thread').innerHTML = '';
  page.adapter.markActivity();
  const b = claudeTurn('user', '<p>B</p>') + claudeTurn('assistant', '<p>hello B</p>');
  page.append(b);
  page.navigate('https://claude.ai/chat/idb', b);
  await scan(page, 4);
  release?.(); // A's tool finishes now
  await wait(1200);
  await scan(page, 10);
  assert.equal(page.sent.length, 0, 'the result of new chat A is NEVER typed into new chat B');
  page.stop();
});

// ───────────── 32. Two separate autoSend=false results: both become delivered (RES-04) ─────────────
scenario(32, async () => {
  const storage = {};
  const page = load(storage, { site: 'claude', url: 'https://claude.ai/chat/a', history: '', autoSend: false });
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>one</p>') + claudeTurn('assistant', block(call('echo STAGE_1'))));
  await wait(2600);
  await scan(page, 10);
  assert.equal(page.sent.length, 1, 'first result staged');
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>two</p>') + claudeTurn('assistant', block(call('echo STAGE_2'))));
  await wait(2600);
  await scan(page, 10);
  assert.equal(page.sent.length, 2, 'second result staged too');
  // The user presses Enter once: BOTH staged results were in the composer and are now sent.
  page.adapter.markActivity();
  page.doc.querySelector('.ProseMirror').textContent = '';
  page.doc.body.insertAdjacentHTML('beforeend', '<button aria-label="Stop response">stop</button>');
  await scan(page, 4);
  const delivered = JSON.parse(storage['wmb:delivered'] ?? '[]');
  assert.equal(delivered.length, 2, 'both staged calls are marked delivered, not just the last one');
  page.stop();
});

// ───────────── 33. New chat A → EXISTING chat B: A's result must not land in B (RES-02) ─────────────
scenario(33, async () => {
  const storage = {};
  let release = null;
  const page = load(storage, {
    site: 'claude',
    url: 'https://claude.ai/new',
    history: '',
    onCall: () => new Promise((resolve) => { release = () => resolve({ ok: true, result: { content: [{ type: 'text', text: 'A result' }] } }); }),
  });
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>A</p>') + claudeTurn('assistant', block(call('echo CHAT_A'))));
  await wait(2600);
  await scan(page, 6);
  assert.ok(page.ran.length >= 1, 'the call of new chat A started');
  // The user opens an EXISTING chat B (one turn) from the sidebar: a real navigation, not a URL assignment.
  page.navigate('https://claude.ai/chat/idb', claudeTurn('user', '<p>B</p>') + claudeTurn('assistant', '<p>hello B</p>'));
  await scan(page, 4);
  release?.();
  await wait(1200);
  await scan(page, 10);
  assert.equal(page.sent.length, 0, 'the result of new chat A is NEVER typed into existing chat B');
  page.stop();
});

// ───────────── 34. Reload BEFORE the new chat gets its URL: pending is resumed (token persisted) ─────────────
scenario(34, async () => {
  const storage = {};
  const html = claudeTurn('user', '<p>run</p>') + claudeTurn('assistant', block(call('echo PENDING_NEW')));
  const first = load(storage, { site: 'claude', url: 'https://claude.ai/new', history: '' });
  await wait(400);
  first.context.WMB.waitFor = async (fn) => fn() || false; // the chat refuses the result
  first.adapter.submit = async () => false;
  first.adapter.markActivity();
  first.append(html);
  await wait(2600);
  await scan(first, 10);
  assert.deepEqual(first.ran, ['echo PENDING_NEW'], 'the call ran before the reload');
  assert.ok(!storage['wmb:delivered'], 'its result was NOT delivered');
  first.stop();

  // Reload while the URL is still /new: the persisted token must let the ledger find the pending call.
  const second = load(storage, { site: 'claude', url: 'https://claude.ai/new', history: html });
  await wait(3000);
  await scan(second, 14);
  assert.deepEqual(second.ran, ['echo PENDING_NEW'], 'the pending call is retried once after the reload');
  assert.equal(second.sent.length, 1, 'and its result is delivered');
  second.stop();
});

// ───────────── 35. Staged + manual clear + unrelated message is NOT a send (RES-04/05) ─────────────
scenario(35, async () => {
  const storage = {};
  const page = load(storage, { site: 'claude', url: 'https://claude.ai/chat/a', history: '', autoSend: false });
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>one</p>') + claudeTurn('assistant', block(call('echo STAGED_LOST'))));
  await wait(2600);
  await scan(page, 10);
  assert.equal(page.sent.length, 1, 'the result is staged');
  // The user SELECTS AND DELETES the staged text, then unrelated AI text appears (regenerate/another turn).
  page.doc.querySelector('.ProseMirror').textContent = '';
  page.append(claudeTurn('assistant', '<p>unrelated message</p>'));
  await scan(page, 10);
  assert.ok(!storage['wmb:delivered'], 'a manual clear without a trusted send does NOT mark it delivered');
  // A real send (trusted send while the staged text is in the composer, then cleared + generation) marks it.
  page.doc.querySelector('.ProseMirror').textContent = page.sent[0];
  page.adapter.markActivity();
  page.doc.querySelector('.ProseMirror').textContent = '';
  page.doc.body.insertAdjacentHTML('beforeend', '<button aria-label="Stop response">stop</button>');
  await scan(page, 4);
  assert.ok(storage['wmb:delivered'], 'a real send still marks it delivered');
  page.stop();
});

// ───────────── 36. URL assignment + re-render of the SAME reply must still deliver (RES-06) ─────────────
scenario(36, async () => {
  const storage = {};
  let release = null;
  const page = load(storage, {
    site: 'claude',
    url: 'https://claude.ai/new',
    history: '',
    onCall: () => new Promise((resolve) => { release = () => resolve({ ok: true, result: { content: [{ type: 'text', text: 'ok' }] } }); }),
  });
  await wait(400);
  page.adapter.markActivity();
  const html = claudeTurn('user', '<p>go</p>') + claudeTurn('assistant', block(call('echo RERENDER')));
  page.append(html);
  await wait(2600);
  await scan(page, 3);
  assert.ok(page.ran.length >= 1, 'the call started in the new chat');
  // The SPA assigns the URL AND re-renders the same reply: new elements, same content.
  page.navigate('https://claude.ai/chat/abc', html);
  await scan(page, 3); // the observer sees the URL change BEFORE the tool returns
  release?.();
  await wait(1200);
  await scan(page, 12);
  assert.equal(page.sent.length, 1, 'the result is delivered once even when the reply is re-rendered');
  assert.ok(page.sent[0].includes('ok'), 'and it is the real result');
  page.stop();
});

// ───────────── 37. Regenerate is a live turn but NOT a trusted send for staged results ─────────────
scenario(37, async () => {
  const storage = {};
  const page = load(storage, { site: 'claude', url: 'https://claude.ai/chat/a', history: '', autoSend: false });
  await wait(400);
  page.adapter.markActivity();
  page.append(claudeTurn('user', '<p>one</p>') + claudeTurn('assistant', block(call('echo REGEN_STAGED'))));
  await wait(2600);
  await scan(page, 10);
  assert.equal(page.sent.length, 1, 'the result is staged');
  // Regenerate: a live turn starts and the composer may be cleared, but nothing was SENT.
  page.doc.querySelector('.ProseMirror').textContent = page.sent[0];
  page.adapter.markActivity({ trustedSend: false });
  page.doc.querySelector('.ProseMirror').textContent = '';
  page.doc.body.insertAdjacentHTML('beforeend', '<button aria-label="Stop response">stop</button>');
  await scan(page, 6);
  assert.ok(!storage['wmb:delivered'], 'regenerate does NOT mark the staged result as delivered');
  page.stop();
});

// ───────────── 38. Every real call gets a result — even after the bad-server budget (no silent null) ─────────────
scenario(38, async () => {
  const storage = {};
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '' });
  await wait(400);
  page.adapter.markActivity();
  const ghost = { mcp_call: { server: 'ghost_server', name: 'run_command', arguments: { command: 'echo ghost' } } };
  page.append(turn('user', '<p>batch</p>') + turn('assistant', multiBlock(ghost, ghost, ghost, call('echo REAL'))));
  await wait(2200);
  await scan(page, 12);
  assert.deepEqual(page.ran, ['echo REAL'], 'only the valid server runs');
  assert.equal((page.sent[0]?.match(/\[MCP_RESULT/g) ?? []).length, 4, 'all four calls get a result block, in order');
  assert.ok((page.sent[0].match(/No MCP server named/g) ?? []).length >= 3, 'each bad-server call is answered');
  page.stop();
});

// ───────────── 39. The access check answers even when the bridge is DISABLED (no silent wait) ─────────────
scenario(39, async () => {
  const storage = {};
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '', bridgeEnabled: false });
  await wait(400);
  page.adapter.markActivity();
  page.append(turn('user', '<p>are you there?</p>') + turn('assistant', block(listCall)));
  await wait(2200);
  await scan(page, 10);
  assert.equal(page.sent.length, 1, 'list_tools is answered even with the bridge disabled');
  assert.match(page.sent[0], /DISABLED/i, 'the answer says WHY no tool can run');
  assert.match(page.sent[0], /enable it/i, 'and what the user should do');
  page.stop();
});

// ───────────── 40. A result of the PREVIOUS turn is not typed into the NEXT turn ─────────────
scenario(40, async () => {
  const storage = {};
  let release = null;
  const page = load(storage, {
    url: 'https://chatgpt.com/c/chat-a',
    history: '',
    onCall: () => new Promise((resolve) => { release = () => resolve({ ok: true, result: { content: [{ type: 'text', text: 'old result' }] } }); }),
  });
  await wait(400);
  page.adapter.markActivity();
  page.append(turn('user', '<p>first</p>') + turn('assistant', block(call('echo OLD_TURN'))));
  await wait(2600);
  await scan(page, 6);
  assert.ok(page.ran.length >= 1, 'the old call is running');
  // The user sends a NEW message while the tool is still running.
  page.adapter.markActivity();
  page.append(turn('user', '<p>second</p>') + turn('assistant', '<p>new turn</p>'));
  await scan(page, 3);
  release?.();
  await wait(1200);
  await scan(page, 10);
  assert.equal(page.sent.length, 0, 'the old result is NOT typed into the new turn');
  page.stop();
});

// ───────────── 41. A bare call and a fenced call in ONE reply are two calls, not three ─────────────
scenario(41, async () => {
  const storage = {};
  const page = load(storage, { url: 'https://chatgpt.com/c/chat-a', history: '' });
  await wait(400);
  page.adapter.markActivity();
  const bare = JSON.stringify(call('echo BARE_A'));
  page.append(turn('user', '<p>mix</p>') + turn('assistant', `${bare}\n${block(call('echo FENCED_B'))}`));
  await wait(2600);
  await scan(page, 12);
  assert.deepEqual(page.ran, ['echo BARE_A', 'echo FENCED_B'], 'both calls run exactly once');
  assert.equal(page.sent.length, 1, 'one result message');
  assert.equal((page.sent[0].match(/\[MCP_RESULT/g) ?? []).length, 2, 'the fenced call is not answered twice');
  page.stop();
});

// Every scenario ran concurrently above; the assertion failures must fail THIS process, and the jsdom
// observers/heartbeats must not keep it alive (the old suite printed ✔ and then hung forever).
await Promise.all(pending);
console.log('✔ test_conversation_isolation: switch, open, refresh, reconnect, navigate mid-flight/after, batch, duplicate ids, late result, restore, text growth, late URL, two new chats, multiply-staged — each runs and delivers exactly once, in the right chat');
process.exit(0);
