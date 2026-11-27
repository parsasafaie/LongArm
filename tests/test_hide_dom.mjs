// Tests the DOM path of hide.js on a fake tree — the layer where real bugs live (a hidden text that leaves its
// bubble behind, prose swallowed with the call, a climb that walks into the next message).
//
// The production code is untouched: `WMB.hideInternals` exposes the four decisions (`findTarget` → which element
// carries the text, `messageElement` → where hiding lands, `isWholeMessage`, `applyHidden` → the plan), and this
// test drives them over fixtures shaped like the four supported sites. It runs in a plain Node VM with a minimal
// DOM, so it needs no browser and no dependency.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ───────────────────────── A minimal DOM (only what hide.js touches) ─────────────────────────

const TEXT = 3;
const ELEMENT = 1;

class FakeNode {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get parentElement() { return this.parentNode?.nodeType === ELEMENT ? this.parentNode : null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === ELEMENT); }
  get nextElementSibling() {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get textContent() {
    if (this.nodeType === TEXT) return this.nodeValue;
    return this.childNodes.map((n) => n.textContent).join('');
  }
  contains(other) {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  append(...nodes) { for (const node of nodes) { const child = typeof node === 'string' ? new FakeText(node) : node; child.parentNode = this; this.childNodes.push(child); } return this; }
  insertBefore(node, before) {
    const at = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    node.parentNode = this;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node);
    return node;
  }
  remove() { const at = this.parentNode?.childNodes.indexOf(this) ?? -1; if (at >= 0) this.parentNode.childNodes.splice(at, 1); this.parentNode = null; }
}

class FakeText extends FakeNode {
  constructor(value) { super(); this.nodeType = TEXT; this.nodeValue = value; }
}

class FakeElement extends FakeNode {
  constructor(tag, attrs = {}) {
    super();
    this.nodeType = ELEMENT;
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.classes = new Set();
    this.style = {
      values: new Map(),
      setProperty(name, value, priority) { this.values.set(name, { value, priority: priority ?? '' }); },
      getPropertyValue(name) { return this.values.get(name)?.value ?? ''; },
      getPropertyPriority(name) { return this.values.get(name)?.priority ?? ''; },
      removeProperty(name) { this.values.delete(name); },
    };
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'class') for (const cls of String(value).split(/\s+/)) if (cls) this.classes.add(cls);
      else this.attributes.set(name, String(value));
    }
  }
  get id() { return this.attributes.get('id') ?? ''; }
  get className() { return [...this.classes].join(' '); }
  setAttribute(name, value) {
    if (name === 'class') { for (const cls of String(value).split(/\s+/)) if (cls) this.classes.add(cls); }
    else this.attributes.set(name, String(value));
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) { return selectors(selector).some((one) => matchesOne(this, one)); }
  closest(selector) {
    for (let node = this; node?.nodeType === ELEMENT; node = node.parentNode) if (node.matches(selector)) return node;
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type, fn) { (this.handlers ??= {})[type] = fn; }
  querySelectorAll(selector) {
    const wanted = selectors(selector);
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (wanted.some((one) => matchesOne(child, one))) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

/** Splits a selector list (`,`), the only combinators our selectors use. */
const selectors = (list) => String(list).split(',').map((s) => s.trim()).filter(Boolean);

/** Matches one simple selector: tag, .class, #id, [attr], [attr="value"] (what hide.js's lists are made of). */
function matchesOne(el, selector) {
  let rest = selector;
  const parts = rest.match(/(^[a-zA-Z][\w-]*)|(\.[\w-]+)|(#[\w-]+)|(\[[^\]]+\])/g);
  if (!parts) return false;
  if (parts.join('') !== rest) return false; // a selector this fake does not understand: never a match
  for (const part of parts) {
    if (part.startsWith('.')) { if (!el.classes.has(part.slice(1))) return false; }
    else if (part.startsWith('#')) { if (el.id !== part.slice(1)) return false; }
    else if (part.startsWith('[')) {
      const attr = /^\[([\w-]+)(?:([~|^$*]?=)"([^"]*)")?\]$/.exec(part);
      if (!attr) return false;
      if (!el.hasAttribute(attr[1])) return false;
      if (attr[3] !== undefined && el.getAttribute(attr[1]) !== attr[3]) return false;
    } else if (el.tagName !== part.toUpperCase()) return false;
  }
  return true;
}

const document = {
  body: null, documentElement: null,
  createElement: (tag) => new FakeElement(tag),
  createTreeWalker(root) {
    // A real browser rejects a Proxy around a Node here; the fake does the same, so an unwrapped Proxy fails.
    if (!(root instanceof FakeNode)) throw new TypeError('createTreeWalker root is not a node');
    const nodes = [];
    const walk = (node) => { for (const child of node.childNodes) { if (child.nodeType === TEXT) nodes.push(child); walk(child); } };
    walk(root);
    let at = -1;
    return { nextNode: () => nodes[++at] ?? null };
  },
  /** The one XPath the scan uses: every text node carrying a bridge marker, in document order. */
  evaluate(expression, root) {
    const found = [];
    const start = root === document ? (document.documentElement ?? document.body) : root;
    const walk = (node) => {
      for (const child of node?.childNodes ?? []) {
        if (child.nodeType === TEXT && (child.nodeValue.includes('MCP_RESULT') || child.nodeValue.includes('mcp_call'))) found.push(child);
        walk(child);
      }
    };
    walk(start);
    return { snapshotLength: found.length, snapshotItem: (at) => found[at] ?? null };
  },
  querySelectorAll: () => [],
  addEventListener() {},
};

// ───────────────────────── Load hide.js in a context with that DOM ─────────────────────────

const context = vm.createContext({ console, setTimeout, clearTimeout, document, location: { hostname: 'claude.ai' }, XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 }, NodeFilter: { SHOW_TEXT: 4 }, MutationObserver: class { observe() {} disconnect() {} }, window: { addEventListener() {} } });
for (const file of ['constants.js', 'utils.js', 'hide.js']) {
  vm.runInContext(readFileSync(new URL(`../content_scripts/${file}`, import.meta.url), 'utf8'), context);
}
const { hideInternals, planHiddenRanges } = context.WMB;
const { findTarget, messageElement, applyHidden, isWholeMessage } = hideInternals;

// ───────────────────────── Building a chat out of fakes ─────────────────────────

const el = (tag, attrs = {}, ...kids) => { const node = new FakeElement(tag, attrs); for (const kid of kids.flat()) node.append(typeof kid === 'string' ? new FakeText(kid) : kid); return node; };
/** The text node the page scan would land on: the first one carrying a marker (its XPath does the same). */
const markerOf = (node) => {
  const walk = (n) => {
    for (const child of n.childNodes) {
      if (child.nodeType === TEXT && /mcp_call|MCP_RESULT/.test(child.nodeValue)) return child;
      const deep = walk(child);
      if (deep) return deep;
    }
    return null;
  };
  return walk(node);
};
const hidden = (node) => node.hasAttribute('data-wmb-hide-message');
/** Visible or not: a node inside a hidden element is gone too (that is how the browser sees it). */
const invisible = (node) => {
  for (let at = node; at; at = at.parentNode) if (at.nodeType === 1 && hidden(at)) return true;
  return false;
};
/** Runs the real pipeline on that text node, the way scan() would. */
const hideAsScan = (node) => { const target = findTarget(markerOf(node)); if (target) applyHidden(target); return target; };
/** The compact lines inserted right before a hidden message (a batch result has one per block, with its own
 *  detail between it and the next line). */
const chipsBefore = (node) => {
  const parent = node.parentNode;
  const lines = [];
  for (let at = (parent?.children.indexOf(node) ?? -1) - 1; at >= 0; at -= 1) {
    const sibling = parent.children[at];
    if (sibling.hasAttribute('data-wmb-chip')) lines.unshift(sibling);
    else if (!sibling.hasAttribute('data-wmb-detail')) break;
  }
  return lines;
};
/** The raw text a line opens (always its immediate next sibling). */
const detailOf = (chip) => chip.nextElementSibling;
const click = (node) => node.handlers?.click?.({ preventDefault() {} });
/** What core_bridge calls when the detected call really starts: the only source of a running line. */
const detect = (element) => context.WMB.hide.running(element);

const JSON_CALL = '{"mcp_call":{"server":"terminal","name":"run","arguments":{"command":"date"}}}';
const JSON_INFO = '{"mcp_call":{"server":"terminal","name":"terminal_info","arguments":{}}}';
const FRAME = '{"mcp_call":{"server":"<server>","name":"<tool>","arguments":{"<arg>":"<value>"}}}';
const RESULT = '[MCP_RESULT server="terminal" tool="run" status="ok"] 21:45 [/MCP_RESULT]';

// ───────────────────────── 1. A pure call (Claude-style block: header + code + actions) ─────────────────────────

{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'what time is it?')),
    el('div', { class: 'font-claude-message' },
      el('div', { class: 'code' },
        el('div', { class: 'head' }, el('span', {}, 'JSON')),
        el('pre', {}, el('code', {}, JSON_CALL))),
      el('div', { class: 'actions' }, el('span', {}, 'copy'), el('span', {}, 'retry'))),
    el('div', { class: 'font-claude-message' }, el('p', {}, 'All done.')));

  const message = chat.children[1];
  hideAsScan(message);

  assert.ok(hidden(message), 'the AI message with a pure call disappears whole');
  assert.ok(invisible(message.children[0]), 'its code block goes with it (header and all)');
  assert.ok(!invisible(chat.children[0]), 'the user’s own message stays');
  assert.ok(!hidden(chat), 'the layout container stays');
  assert.equal(message.style.getPropertyValue('display'), 'none', 'hiding is display-only');
  const [running] = chipsBefore(message);
  assert.equal(running, undefined, 'an answered call in history leaves no running line (a later reply exists)');
}

// ───────────────────────── 2. A result in its bubble (text hidden but the box staying was the old bug) ─────────────────────────

{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'what time is it?')),
    el('div', { class: 'bubble blue' },
      el('div', { 'data-message-author-role': 'user' }, el('div', {}, el('p', {}, RESULT))),
      el('span', { class: 'stamp' }, '12:45')));

  const bubble = chat.children[1];
  hideAsScan(bubble);

  assert.ok(hidden(bubble), 'the bubble itself is hidden, not only the text inside it');
  assert.ok(invisible(bubble.children[0]), 'and so is the message inside it');
  assert.ok(!invisible(chat.children[0]), 'the earlier user message stays');
  assert.ok(!hidden(chat), 'the container stays');
  const [line] = chipsBefore(bubble);
  assert.ok(line, 'a hidden result leaves one compact line behind');
  assert.ok(line.textContent.includes('terminal') && line.textContent.includes('run'), 'the line says which MCP tool ran');
  assert.ok(detailOf(line).textContent.includes('21:45'), 'its detail is the result’s own text');
  click(line);
  assert.equal(detailOf(line).style.getPropertyValue('display'), '', 'clicking the line opens its own result');
  click(line);
  assert.equal(detailOf(line).style.getPropertyValue('display'), 'none', 'clicking again tucks it away');
  assert.equal(bubble.style.getPropertyValue('display'), 'none', 'the site message stays hidden either way');
}

// ───────────────────────── 3. Prose around the call: only the block goes ─────────────────────────

{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-claude-message' },
      el('div', { class: 'md' }, el('p', {}, 'Sure — running a second one:')),
      el('div', { class: 'code' },
        el('div', { class: 'head' }, el('span', {}, 'JSON')),
        el('pre', {}, el('code', {}, JSON_INFO)))));

  const message = chat.children[0];
  const prose = message.children[0];
  const block = message.children[1];
  hideAsScan(message);
  detect(message);

  assert.ok(!hidden(message), 'the message stays: the AI’s own words are never hidden');
  assert.ok(hidden(block), 'the code block (header included) is what disappears');
  assert.ok(!hidden(prose), 'the prose stays');
  assert.equal(chipsBefore(message).length, 1, 'the call still leaves its running line, above the message (never inside its text)');
}

// ───────────────────────── 4. Never touched ─────────────────────────

{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-claude-message' }, el('div', { class: 'code' }, el('pre', {}, el('code', {}, FRAME)))),
    el('div', { class: 'font-user-message' }, el('p', {}, `why did this fail? ${JSON_CALL}`)),
    el('div', { class: 'font-claude-message' }, el('p', {}, 'the frame looks like this: {\'mcp_call\': …}')));

  hideAsScan(chat.children[0]);
  hideAsScan(chat.children[1]);
  hideAsScan(chat.children[2]);

  assert.ok(!hidden(chat.children[0]), 'the frame the instructions spell out is not a call');
  assert.ok(!hidden(chat.children[1]), 'a call pasted into the user’s own text is their text');
  assert.ok(!hidden(chat.children[2]), 'prose mentioning mcp_call stays');
  assert.ok(!hidden(chat), 'nothing was hidden at all');
}

// ───────────────────────── 5. The climb never walks into a container with another message ─────────────────────────

{
  const log = el('div', { role: 'log' },
    el('div', { class: 'font-claude-message' }, el('div', { class: 'code' }, el('pre', {}, el('code', {}, JSON_CALL)))),
    el('div', { class: 'font-user-message' }, el('p', {}, RESULT))); // «role="log"» is never hidden

  const message = log.children[0];
  const target = hideAsScan(message);

  assert.ok(hidden(message), 'the message is hidden');
  assert.ok(!hidden(log), 'the log container is never hidden');
  assert.equal(messageElement(message, true), message, 'the climb stops at the message');
  assert.equal(isWholeMessage(message, target.el), true, 'a call-only message counts as the whole message');
}

// ───────────────────────── 6. What the plans say about the same fixtures ─────────────────────────

{
  const bubble = el('div', { class: 'bubble' }, el('div', { 'data-message-author-role': 'user' }, el('p', {}, RESULT)));
  const { el: found, ranges } = findTarget(markerOf(bubble));
  assert.ok(found, 'a result is found');
  assert.equal(planHiddenRanges(ranges ? '' : '').length, 0, 'sanity: an empty text has no plan');
  assert.ok(ranges.length > 0, 'the result carries a whole-message plan');
}

// ───────────────────────── 7. A sent message inside the composer's own <form> (Gemini-style) ─────────────────────────
// Some sites wrap the whole conversation in the composer's form. The form must protect the DRAFT, not the
// sent messages in it: a result there is hidden, and the editable itself stays untouched.
{
  const form = el('form', { class: 'composer-host' },
    el('div', { class: 'conversation-container' },
      el('user-query', {}, el('div', { class: 'markdown' }, el('p', {}, RESULT))),
      el('model-response', {}, el('div', { class: 'markdown' }, el('p', {}, JSON_CALL)))),
    el('div', { class: 'input-area' }, el('div', { contenteditable: 'true' }, 'a draft the user is typing')));

  hideAsScan(form.querySelector('user-query'));
  hideAsScan(form.querySelector('model-response'));

  assert.ok(invisible(form.querySelector('user-query')), 'a result inside a form-wrapped conversation is hidden');
  assert.ok(invisible(form.querySelector('model-response')), 'the call in the same form hides too');
  assert.ok(!invisible(form.querySelector('.input-area div')), 'the draft in the same form stays visible');
  assert.ok(!hidden(form), 'the form itself is never hidden (the climb stops at the composer inside it)');
}

// ───────────────────────── 8. A sent message rendered in a role=textbox container ─────────────────────────
// Some sites render the user's sent messages inside a role="textbox" (or contenteditable) container. The
// draft protection must not swallow them: a result there hides, and a REAL draft (no message element
// around it) stays protected.
{
  const chat = el('main', {},
    el('user-query', {}, el('div', { role: 'textbox' }, el('p', {}, RESULT))),
    el('model-response', {}, el('div', { role: 'textbox' }, el('p', {}, JSON_CALL))),
    el('div', { contenteditable: 'true' }, 'a draft the user is typing'));

  const resultMessage = chat.children[0];
  const callMessage = chat.children[1];
  const draft = chat.children[2];
  hideAsScan(resultMessage);
  assert.ok(invisible(resultMessage), 'a result in a role=textbox message container is hidden');
  hideAsScan(callMessage);
  assert.ok(invisible(callMessage), 'a call in a role=textbox message container is hidden too');
  // The draft carries no marker, so the scan never even lands on it — the point is it stays untouched.
  assert.ok(!hidden(draft) && !invisible(draft), 'a real draft (no message element around it) is never touched');
}

// ───────────────── 9. Gemini's "You said " label in front of the result ─────────────────
// Gemini renders the user's sent text with a tiny label in front and collapses long messages (the DOM
// keeps the last line). The prefixed result must hide WHOLE, label and all — it is a user message, and
// it ends with the closing tag.
{
  const main = el('main', {},
    el('user-query', {},
      el('div', { class: 'query-text gds-body-l collapsed' },
        el('span', { class: 'label' }, 'You said '),
        el('p', { class: 'query-text-line' }, '[MCP_RESULT server="terminal" tool="run_command" status="ok"]'),
        el('p', { class: 'query-text-line' }, 'exit code: 0 (0.12 s)'),
        el('p', { class: 'query-text-line' }, '[/MCP_RESULT]'))),
    el('model-response', {}, el('p', {}, JSON_CALL)));

  const resultMessage = main.children[0];
  const callMessage = main.children[1];
  hideAsScan(resultMessage);
  assert.ok(invisible(resultMessage), 'the prefixed result (with its "You said" label) hides whole');
  hideAsScan(callMessage);
  assert.ok(invisible(callMessage), 'the call still hides');
  assert.equal(chipsBefore(resultMessage).length, 1, 'the prefixed result still leaves its compact line');
}

// ───────────────────────── 10. A batch of calls (the protocol allows several in one message) ─────────────────
// The page collapses the line breaks between the calls, so a batch must be recognised by bracket balance, not by
// splitting on '\n'. A batch rendered as one code block disappears whole.
{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'run both')),
    el('div', { class: 'font-claude-message' },
      el('div', { class: 'code' },
        el('div', { class: 'head' }, el('span', {}, 'JSON')),
        el('pre', {}, el('code', {}, `${JSON_CALL}\n${JSON_INFO}`))),
      el('div', { class: 'actions' }, el('span', {}, 'copy'), el('span', {}, 'retry'))));

  const message = chat.children[1];
  hideAsScan(message);
  detect(message);

  assert.ok(hidden(message), 'a batch of calls in one block disappears whole');
  assert.ok(!hidden(chat.children[0]), 'the user’s own message stays');
  assert.equal(chipsBefore(message).length, 2, 'each call in the batch leaves its running line');
}

// One fenced block per call renders as separate blocks. The message is still nothing but calls, so the whole
// message goes (not just its blocks) and both running lines appear at once.
{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'run both')),
    el('div', { class: 'font-claude-message' },
      el('div', { class: 'code' }, el('pre', {}, el('code', {}, JSON_CALL))),
      el('div', { class: 'code' }, el('pre', {}, el('code', {}, JSON_INFO)))));

  const message = chat.children[1];
  hideAsScan(message.children[0]);
  detect(message);

  assert.ok(hidden(message), 'the whole message goes when every block is a call');
  assert.equal(chipsBefore(message).length, 2, 'both calls leave their running line at once');
}

// ───────────────────────── 11. A batch result: one compact line per block ─────────────────
{
  const resultA = '[MCP_RESULT server="terminal" tool="run" status="ok"] x [/MCP_RESULT]';
  const resultB = '[MCP_RESULT server="bridge" tool="list_tools" status="error"] y [/MCP_RESULT]';
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'run both')),
    el('div', { class: 'font-user-message' }, el('p', {}, `${resultA}\n${resultB}`)));

  const message = chat.children[1];
  hideAsScan(message);

  const lines = chipsBefore(message);
  assert.equal(lines.length, 2, 'each result block gets its own line');
  assert.ok(hidden(message), 'the raw result stays out of sight');
  assert.ok(lines[0].textContent.includes('terminal') && lines[0].textContent.includes('run'), 'the first line names the first call');
  assert.ok(lines[1].textContent.includes('bridge') && lines[1].textContent.includes('error'), 'the second line carries its own status');
  assert.equal(detailOf(lines[0]).textContent, 'x', 'the first line opens only the first result');
  assert.equal(detailOf(lines[1]).textContent, 'y', 'the second line opens only the second result');
  click(lines[0]);
  assert.equal(detailOf(lines[0]).style.getPropertyValue('display'), '');
  assert.equal(detailOf(lines[1]).style.getPropertyValue('display'), 'none', 'opening one leaves its sibling closed');
}

// ───────────────────────── 12. The running line becomes the result's ─────────────────
// The result arrives as a NEW message while the call is still the newest one; a conversation loaded with both
// already in place is history and must not claim anything is running (see section 1).
{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'what time is it?')),
    el('div', { class: 'font-claude-message' }, el('div', { class: 'code' }, el('pre', {}, el('code', {}, JSON_CALL)))));

  const callMessage = chat.children[1];
  hideAsScan(callMessage);
  detect(callMessage);
  assert.equal(chipsBefore(callMessage).length, 1, 'the waiting call leaves its running line');
  assert.ok(chipsBefore(callMessage)[0].textContent.includes('running'), 'and it says running');

  const resultMessage = el('div', { class: 'font-user-message' }, el('p', {}, RESULT));
  chat.append(resultMessage);
  hideAsScan(resultMessage);
  assert.equal(chipsBefore(callMessage).length, 0, 'the result replaces the running line instead of adding a second one');
  const [line] = chipsBefore(resultMessage);
  assert.ok(line && line.textContent.includes('terminal') && !line.textContent.includes('running'), 'one line, with the result’s outcome');
  click(line);
  assert.equal(detailOf(line).style.getPropertyValue('display'), '', 'the result line opens the result’s own text');
}

// A wrong server name is answered under the bridge's name, with the requested tool: the running line still ends.
{
  const wrongCall = '{"mcp_call":{"server":"nope","name":"run","arguments":{}}}';
  const bridgeError = '[MCP_RESULT server="bridge" tool="run" status="error"] No MCP server named «nope» [/MCP_RESULT]';
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'go')),
    el('div', { class: 'font-claude-message' }, el('div', { class: 'code' }, el('pre', {}, el('code', {}, wrongCall)))));

  const callMessage = chat.children[1];
  hideAsScan(callMessage);
  detect(callMessage);
  assert.equal(chipsBefore(callMessage).length, 1, 'the call is running');
  const resultMessage = el('div', { class: 'font-user-message' }, el('p', {}, bridgeError));
  chat.append(resultMessage);
  hideAsScan(resultMessage);
  assert.equal(chipsBefore(callMessage).length, 0, 'the notice ends the running line even under another server name');
  assert.ok(chipsBefore(resultMessage)[0].textContent.includes('error'), 'the line carries the notice’s status');
}

// ───────────────────────── 13. A large call (long arguments, a big batch) is still a call ─────────────────
{
  const bigCall = `{"mcp_call":{"server":"terminal","name":"write","arguments":{"text":"${'x'.repeat(9000)}"}}}`;
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'write it')),
    el('div', { class: 'font-claude-message' }, el('div', { class: 'code' }, el('pre', {}, el('code', {}, bigCall)))));

  const message = chat.children[1];
  hideAsScan(message);
  detect(message);
  assert.ok(hidden(message), 'a call past the old 8K bound still disappears');
  assert.equal(chipsBefore(message).length, 1, 'and still leaves its line');

  const prose = el('div', { class: 'font-claude-message' },
    el('p', {}, `A long answer about mcp_call: ${'word '.repeat(2000)}`));
  const longChat = el('div', {}, el('div', { class: 'font-user-message' }, el('p', {}, 'hi')), prose);
  assert.equal(findTarget(markerOf(prose)), null, 'a long prose reply is never even indexed as a call');
}

// ───────────────────────── 14. A multi-block batch with code headers and action labels ─────────────────
// Real renderers add small print between the blocks (`JSON`, Copy, Retry). The message is still only calls.
{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'run both')),
    el('div', { class: 'font-claude-message' },
      el('div', { class: 'code' },
        el('div', { class: 'head' }, el('span', {}, 'JSON')),
        el('pre', {}, el('code', {}, JSON_CALL))),
      el('div', { class: 'code' },
        el('div', { class: 'head' }, el('span', {}, 'JSON')),
        el('pre', {}, el('code', {}, JSON_INFO))),
      el('div', { class: 'actions' }, el('span', {}, 'copy'), el('span', {}, 'retry'))));

  const message = chat.children[1];
  hideAsScan(message.children[0]);
  detect(message);

  assert.ok(hidden(message), 'headers and action labels do not leave an empty bubble behind');
  assert.equal(chipsBefore(message).length, 2, 'both calls leave their running line');
}

// ───────────────────────── 15. An old chat loaded from history: nothing is running ─────────────────
// Both messages are already on the page (the call was answered before the page opened). The call must not
// claim to be running; only the result's line belongs here.
{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'what time was it?')),
    el('div', { class: 'font-claude-message' }, el('div', { class: 'code' }, el('pre', {}, el('code', {}, JSON_CALL)))),
    el('div', { class: 'font-user-message' }, el('p', {}, RESULT)),
    el('div', { class: 'font-claude-message' }, el('p', {}, 'It was 21:45.')));

  const callMessage = chat.children[1];
  const resultMessage = chat.children[2];
  hideAsScan(callMessage);
  assert.equal(chipsBefore(callMessage).length, 0, 'a call already in history never says running');
  hideAsScan(resultMessage);
  const [line] = chipsBefore(resultMessage);
  assert.ok(line && line.textContent.includes('terminal') && !line.textContent.includes('running'), 'only the result’s line remains');
}

// ───────────────────────── 16. A batch of calls: each widget opens only its own request ─────────────────
{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'run both')),
    el('div', { class: 'font-claude-message' },
      el('div', { class: 'code' }, el('pre', {}, el('code', {}, `${JSON_CALL}\n${JSON_INFO}`)))));

  const message = chat.children[1];
  hideAsScan(message);
  detect(message);

  const [first, second] = chipsBefore(message);
  const firstBody = detailOf(first);
  const secondBody = detailOf(second);
  assert.equal(firstBody.nextElementSibling, second, 'the first detail sits exactly between the two widgets');
  assert.ok(firstBody.textContent.includes('"run"') && firstBody.textContent.includes('"command"'), 'the first detail is the first request');
  assert.ok(secondBody.textContent.includes('terminal_info') && !secondBody.textContent.includes('"command"'), 'the second detail is the second request');

  click(first);
  assert.equal(firstBody.style.getPropertyValue('display'), '', 'the first widget opens its own detail');
  assert.equal(secondBody.style.getPropertyValue('display'), 'none', 'the second widget stays closed');

  click(second);
  assert.equal(secondBody.style.getPropertyValue('display'), '', 'the second widget opens its own detail');
  click(first);
  assert.equal(firstBody.style.getPropertyValue('display'), 'none', 'each closes independently');
}

// ───────────────────────── 17. History rendered progressively: the running line is withdrawn ─────────────────
// A call the bridge really started stops being the newest when the conversation moves on. Its running line
// must be withdrawn instead of staying as a lie on screen.
{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'what time?')),
    el('div', { class: 'font-claude-message' }, el('div', { class: 'code' }, el('pre', {}, el('code', {}, JSON_CALL)))));

  const callMessage = chat.children[1];
  hideAsScan(callMessage);
  detect(callMessage);
  assert.equal(chipsBefore(callMessage).length, 1, 'the bridge started it, so it is running');

  chat.append(el('div', { class: 'font-claude-message' }, el('p', {}, 'the rest of the history arrived')));
  context.WMB.hide.scan();
  assert.equal(chipsBefore(callMessage).length, 0, 'once a later message exists, the running line is gone');
}

// ───────────────────────── 18. Our own detail is never scanned as a call ─────────────────
// The detail holds the call's JSON (`mcp_call`). If a scan treated it as a message it would hide it and add
// another line — a loop that kept growing the chat with new running widgets.
{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'run it')),
    el('div', { class: 'font-claude-message' }, el('div', { class: 'code' }, el('pre', {}, el('code', {}, JSON_CALL)))));
  document.body = el('body', {}, chat);
  document.documentElement = document.body;
  const count = () => chat.children.filter((node) => node.hasAttribute('data-wmb-chip')).length;

  context.WMB.hide.scan();
  detect(chat.children[1]);
  const first = count();
  assert.equal(first, 1, 'the call leaves one line');

  for (let i = 0; i < 5; i += 1) context.WMB.hide.scan();
  assert.equal(count(), first, 'rescanning never multiplies our own line');

  document.body = null;
  document.documentElement = null;
}

// ───────────────────────── 19. ChatGPT's block-aware Proxy is unwrapped ─────────────────
// The adapter hands a Proxy whose textContent is block-aware; hiding needs the real node behind it.
{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'run it')),
    el('div', { class: 'font-claude-message' }, el('div', { class: 'code' }, el('pre', {}, el('code', {}, JSON_CALL)))));
  const message = chat.children[1];
  const proxy = new Proxy(message, {
    get(target, prop) {
      if (prop === '__raw') return target;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  context.WMB.hide.running(proxy);

  assert.ok(hidden(message), 'the real message is hidden, not the Proxy');
  assert.equal(chipsBefore(message).length, 1, 'and its running line is created');
}

// ───────────────────────── 20. A call the bridge will not answer loses its line ─────────────────
{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'run it')),
    el('div', { class: 'font-claude-message' }, el('div', { class: 'code' }, el('pre', {}, el('code', {}, JSON_CALL)))));
  const message = chat.children[1];
  hideAsScan(message);
  detect(message);
  assert.equal(chipsBefore(message).length, 1, 'it was running');

  context.WMB.hide.dropped(message, { server: 'terminal', name: 'run' });
  assert.equal(chipsBefore(message).length, 0, 'a call that gets no result keeps no running line');
  assert.equal(chat.children.filter((node) => node.hasAttribute('data-wmb-detail')).length, 0, 'and its detail goes with it');
}

console.log('✔ test_hide_dom: all checks passed');
