/**
 * test_hide_compact.mjs — the compact view after the SITE touches the page.
 *
 * Two real-world failures these guard:
 *   · a reply that puts its calls beside a sentence stayed raw on screen (the parser ran them, no widget appeared);
 *   · a site that re-rendered a hidden element — wiping the inline display, or reusing the node for a different
 *     message — left the raw protocol visible again, or kept an unrelated answer hidden forever.
 *
 * Drives the real `hide.js` against a ChatGPT-like page in jsdom: everything asserted here is what the user sees.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch {
  console.error('✘ test_hide_compact needs jsdom: run `npm install`');
  process.exit(1);
}

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const SCRIPTS = ['content_scripts/constants.js', 'content_scripts/utils.js', 'content_scripts/mcp_parser.js', 'content_scripts/hide.js'];
const CALL = (cmd) => `{"mcp_call":{"server":"terminal","name":"run_command","arguments":{"command":"${cmd}"}}}`;
const RESULT = (cmd) => `[MCP_RESULT server="terminal" tool="run_command" status="ok"] ${cmd}: 0 (0.10 s) [/MCP_RESULT]`;
const MESSAGE_ATTR = 'data-wmb-hide-message';
const CHIP_ATTR = 'data-wmb-chip';
const HIDDEN_ATTR = 'data-wmb-hidden';

// Reality: every turn carries a screen-reader label, and a reply carries its action bar (Copy, Good response…).
const article = (role, inner) => `<article data-turn="${role}"><h5 class="sr-only select-none">${role} said:</h5>`
  + `<div data-message-author-role="${role}"><div class="markdown">${inner}</div></div>`
  + (role === 'assistant' ? '<div class="actions"><button>Copy</button><button>Good response</button></div>' : '')
  + '</article>';
/** A rendered JSON code block: the language label and the Copy button live inside the <pre>. */
const code = (text) => `<pre><div class="hdr"><span>json</span><button>Copy code</button></div><div><code>${text}</code></div></pre>`;
const chat = (inner) => `<main><div id="thread">${article('user', '<p>check the machine</p>')}${article('assistant', inner)}</div></main>`;

function load(inner) {
  const dom = new JSDOM(`<!doctype html><html><body>${chat(inner)}</body></html>`, { url: 'https://chatgpt.com/c/1', runScripts: 'outside-only' });
  for (const file of SCRIPTS) dom.window.eval(read(file));
  return dom.window;
}

/** What the user sees: our lines and hidden text taken out, the rest of the message as one string. */
function visible(el) {
  const clone = el.cloneNode(true);
  for (const node of clone.querySelectorAll(`[${HIDDEN_ATTR}], [${MESSAGE_ATTR}], [${CHIP_ATTR}], [data-wmb-detail], script, style, noscript, template`)) node.remove();
  return clone.textContent.replace(/\s+/g, ' ').trim();
}
const chips = (doc) => [...doc.querySelectorAll(`[${CHIP_ATTR}]`)].map((chip) => chip.textContent);
const hiddenText = (doc) => [...doc.querySelectorAll(`[${HIDDEN_ATTR}]`)].map((span) => span.textContent).join(' ');
const assistant = (doc) => doc.querySelector('[data-message-author-role="assistant"]');

// 1. A pure batch rendered as two code blocks: the message goes, and every call of the reply gets its line.
{
  const w = load(`${code(CALL('ver'))}\n${code(CALL('hostname'))}`);
  const doc = w.document;
  const message = assistant(doc);
  w.WMB.hide.scan();
  assert.ok(message.closest(`[${MESSAGE_ATTR}]`), 'a pure call message disappears');
  // core_bridge reports the FIRST block the adapter detected: the whole message still supplies every call.
  w.WMB.hide.running(message.querySelector('pre'));
  assert.equal(chips(doc).length, 2, 'both calls of the batch leave their running line');
  assert.ok(chips(doc).every((text) => text.includes('running')), 'and they say running');
}

// 2. Calls beside a sentence (the protocol was broken, but the calls run): only the JSON hides, with widgets.
{
  const w = load(`<p>Let me check both: ${CALL('ver')} ${CALL('hostname')}</p>`);
  const doc = w.document;
  const message = assistant(doc);
  const paragraph = message.querySelector('p');
  w.WMB.hide.scan();
  assert.ok(!message.closest(`[${MESSAGE_ATTR}]`), 'the message itself is not hidden: the sentence is the AI’s');
  assert.equal(visible(message), 'Let me check both:', 'only the call JSON is gone');
  assert.ok(hiddenText(doc).includes('run_command'), 'the calls are hidden in place');
  w.WMB.hide.running(paragraph);
  assert.equal(chips(doc).length, 2, 'and each inline call gets its widget');
}

// 3. The site re-rendered the hidden element and wiped the inline display: the hiding is applied again.
{
  const w = load(code(CALL('ver')));
  const doc = w.document;
  w.WMB.hide.scan();
  const target = doc.querySelector(`[${MESSAGE_ATTR}]`);
  assert.ok(target, 'the call message was hidden');
  target.style.removeProperty('display'); // React owns the style attribute; the site's repaint drops our inline rule
  w.WMB.hide.scan();
  assert.equal(target.style.getPropertyValue('display'), 'none', 'the raw protocol does not stay on screen');
}

// 4. The site reused the hidden element for an UNRELATED reply: that reply must come back, with no line left behind.
{
  const w = load(code(CALL('ver')));
  const doc = w.document;
  w.WMB.hide.scan();
  w.WMB.hide.running(assistant(doc).querySelector('pre'));
  assert.equal(chips(doc).length, 1, 'the call was running');
  const target = doc.querySelector(`[${MESSAGE_ATTR}]`);
  target.innerHTML = '<div class="markdown"><p>Your OS is Windows 11 and the host is PARSA-PC.</p></div>';
  w.WMB.hide.scan();
  assert.ok(!target.hasAttribute(MESSAGE_ATTR), 'a reused element is not hidden any more');
  assert.equal(visible(target), 'Your OS is Windows 11 and the host is PARSA-PC.', 'the unrelated answer is back');
  assert.equal(chips(doc).length, 0, 'and the call’s line went with it');
}

// 5. Prose in the same message is never swallowed with the call, however short it is.
{
  const w = load(`<p>One moment.</p>${code(CALL('ver'))}`);
  const doc = w.document;
  const message = assistant(doc);
  w.WMB.hide.scan();
  assert.ok(!message.closest(`[${MESSAGE_ATTR}]`), 'the reply with prose stays');
  assert.equal(visible(message), 'One moment.', 'the prose is not deleted with the call block');
}

// 6. A batch result: one line per block, and the call's running line is replaced, not duplicated.
{
  const w = load(`${code(CALL('ver'))}\n${code(CALL('hostname'))}`);
  const doc = w.document;
  w.WMB.hide.scan();
  w.WMB.hide.running(assistant(doc).querySelector('pre'));
  assert.equal(chips(doc).length, 2, 'two calls were running');
  const thread = doc.getElementById('thread');
  const result = doc.createElement('article');
  result.setAttribute('data-turn', 'user');
  result.innerHTML = `<div data-message-author-role="user"><div class="markdown"><p>${RESULT('ver')}\n${RESULT('hostname')}</p></div></div>`;
  thread.append(result);
  w.WMB.hide.scan();
  const resultLines = chips(doc);
  assert.equal(resultLines.length, 2, 'the two result blocks get one line each');
  assert.ok(resultLines.every((text) => !text.includes('running')), 'nothing keeps claiming it is running');
  assert.ok(result.closest(`[${MESSAGE_ATTR}]`), 'the raw result is out of sight');
}

// 7. A screen-reader label or the turn's action bar must not keep a hidden turn on screen.
{
  const w = load(code(CALL('ver')));
  const doc = w.document;
  w.WMB.hide.scan();
  const turn = doc.querySelector('[data-turn="assistant"]');
  assert.ok(turn.hasAttribute(MESSAGE_ATTR), 'the whole turn goes, not only its bubble');
  assert.ok(doc.querySelector('.actions').closest(`[${MESSAGE_ATTR}]`) === turn, 'its action bar goes with it');
  const result = doc.createElement('article');
  result.setAttribute('data-turn', 'user');
  result.innerHTML = `<h5 class="sr-only">You said:</h5><div data-message-author-role="user"><div class="markdown"><p>${RESULT('ver')}</p></div></div>`;
  doc.getElementById('thread').append(result);
  w.WMB.hide.scan();
  assert.ok(result.getAttribute(MESSAGE_ATTR) === '1', 'a result turn with a screen-reader label hides whole too');
}

// 8. Our inline spans are repaired like whole messages: a wiped display must not expose the JSON again.
{
  const w = load(`<p>Let me check: ${CALL('ver')}</p>`);
  const doc = w.document;
  w.WMB.hide.scan();
  const span = doc.querySelector(`[${HIDDEN_ATTR}]`);
  assert.ok(span, 'the inline JSON was wrapped');
  span.style.removeProperty('display');
  w.WMB.hide.scan();
  assert.equal(span.style.getPropertyValue('display'), 'none', 'the JSON stays out of sight after a re-render');
}

// 9. A span the site kept while replacing its text must not hide unrelated content.
{
  const w = load(`<p>Let me check: ${CALL('ver')}</p>`);
  const doc = w.document;
  w.WMB.hide.scan();
  const span = doc.querySelector(`[${HIDDEN_ATTR}]`);
  span.textContent = 'the rest of the sentence';
  w.WMB.hide.scan();
  assert.equal(doc.querySelector(`[${HIDDEN_ATTR}]`), null, 'the stale span is unwrapped');
  assert.ok(visible(assistant(doc)).includes('the rest of the sentence'), 'and its new text is visible');
}

// 10. A batch beside a sentence: every hidden block of the reply gets its line, not only the detected block.
{
  const w = load(`<p>Let me check both:</p>${code(CALL('ver'))}${code(CALL('hostname'))}`);
  const doc = w.document;
  const message = assistant(doc);
  w.WMB.hide.scan();
  assert.equal(message.querySelectorAll(`[${MESSAGE_ATTR}]`).length, 2, 'both call blocks are hidden');
  w.WMB.hide.running(message.querySelector('pre'));
  assert.equal(chips(doc).length, 2, 'one running line per call of the batch');
  assert.equal(visible(message), 'Let me check both:', 'the sentence still stays');
}

// 11. Site scripts carry the conversation data too: their text is never a message (and is never indexed).
{
  const w = load(`<script type="application/json">${CALL('ver')}</script><p>Hello</p>${code(CALL('hostname'))}`);
  const doc = w.document;
  const message = assistant(doc);
  w.WMB.hide.scan();
  assert.equal(doc.querySelector('script').closest(`[${MESSAGE_ATTR}]`), null, 'a script is not a message');
  assert.equal(message.closest(`[${MESSAGE_ATTR}]`), null, 'the script does not get its reply hidden');
  assert.equal(message.querySelectorAll(`[${MESSAGE_ATTR}]`).length, 1, 'the real call block still hides');
  assert.equal(visible(message), 'Hello', 'and the sentence stays');
}

// 12. Turning the option off puts everything back (including inline spans); on hides it again.
{
  const w = load(`<p>Let me check: ${CALL('ver')}</p>${code(CALL('hostname'))}`);
  const doc = w.document;
  const message = assistant(doc);
  w.WMB.hide.scan();
  w.WMB.hide.running(message.querySelector('pre'));
  assert.ok(doc.querySelector(`[${HIDDEN_ATTR}]`) || doc.querySelector(`[${MESSAGE_ATTR}]`), 'something is hidden');
  w.WMB.hide.configure(false);
  assert.equal(doc.querySelector(`[${MESSAGE_ATTR}]`), null, 'no hidden message is left');
  assert.equal(doc.querySelector(`[${HIDDEN_ATTR}]`), null, 'no hidden span is left');
  assert.equal(chips(doc).length, 0, 'no line is left');
  assert.ok(visible(message).includes('run_command'), 'the raw protocol is back');
  w.WMB.hide.configure(true);
  assert.ok(doc.querySelector(`[${HIDDEN_ATTR}]`), 'turning it on hides the inline call again');
}

// 13. A reply may mix a call beside a sentence with a call block: both get their line, and none stays raw.
{
  const w = load(`<p>First: ${CALL('ver')}</p>${code(CALL('hostname'))}`);
  const doc = w.document;
  const message = assistant(doc);
  w.WMB.hide.scan();
  w.WMB.hide.running(message.querySelector('pre'));
  assert.equal(chips(doc).length, 2, 'the inline call and the block each get a running line');
  assert.ok(visible(message).includes('First:'), 'the sentence stays');
  assert.ok(!visible(message).includes('mcp_call'), 'no raw call is left visible');
}

console.log('✔ test_hide_compact: inline calls, batch widgets, wiped display, reused elements and screen-reader labels all keep the chat honest');
process.exit(0);
