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
  get textContent() {
    if (this.nodeType === TEXT) return this.nodeValue;
    return this.childNodes.map((n) => n.textContent).join('');
  }
  contains(other) {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.childNodes.push(node); } return this; }
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
  createTreeWalker(root) {
    const nodes = [];
    const walk = (node) => { for (const child of node.childNodes) { if (child.nodeType === TEXT) nodes.push(child); walk(child); } };
    walk(root);
    let at = -1;
    return { nextNode: () => nodes[++at] ?? null };
  },
  evaluate: () => ({ snapshotLength: 0 }), // scan() finds nothing: the tests drive the decisions themselves
  querySelectorAll: () => [],
  addEventListener() {},
};

// ───────────────────────── Load hide.js in a context with that DOM ─────────────────────────

const context = vm.createContext({ console, setTimeout, clearTimeout, document, NodeFilter: { SHOW_TEXT: 4 }, MutationObserver: class { observe() {} disconnect() {} }, window: { addEventListener() {} } });
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

  hideAsScan(chat.children[1]);

  assert.ok(hidden(chat.children[1]), 'the AI message with a pure call disappears whole');
  assert.ok(invisible(chat.children[1].children[0]), 'its code block goes with it (header and all)');
  assert.ok(!invisible(chat.children[0]), 'the user’s own message stays');
  assert.ok(!hidden(chat), 'the layout container stays');
  assert.equal(chat.children[1].style.getPropertyValue('display'), 'none', 'hiding is display-only');
}

// ───────────────────────── 2. A result in its bubble (text hidden but the box staying was the old bug) ─────────────────────────

{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-user-message' }, el('p', {}, 'what time is it?')),
    el('div', { class: 'bubble blue' },
      el('div', { 'data-message-author-role': 'user' }, el('div', {}, el('p', {}, RESULT))),
      el('span', { class: 'stamp' }, '12:45')));

  hideAsScan(chat.children[1]);

  assert.ok(hidden(chat.children[1]), 'the bubble itself is hidden, not only the text inside it');
  assert.ok(invisible(chat.children[1].children[0]), 'and so is the message inside it');
  assert.ok(!invisible(chat.children[0]), 'the earlier user message stays');
  assert.ok(!hidden(chat), 'the container stays');
}

// ───────────────────────── 3. Prose around the call: only the block goes ─────────────────────────

{
  const chat = el('div', { id: 'chat' },
    el('div', { class: 'font-claude-message' },
      el('div', { class: 'md' }, el('p', {}, 'Sure — running a second one:')),
      el('div', { class: 'code' },
        el('div', { class: 'head' }, el('span', {}, 'JSON')),
        el('pre', {}, el('code', {}, JSON_INFO)))));

  hideAsScan(chat.children[0]);

  assert.ok(!hidden(chat.children[0]), 'the message stays: the AI’s own words are never hidden');
  assert.ok(hidden(chat.children[0].children[1]), 'the code block (header included) is what disappears');
  assert.ok(!hidden(chat.children[0].children[0]), 'the prose stays');
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

  const target = hideAsScan(log.children[0]);

  assert.ok(hidden(log.children[0]), 'the message is hidden');
  assert.ok(!hidden(log), 'the log container is never hidden');
  assert.equal(messageElement(log.children[0], true), log.children[0], 'the climb stops at the message');
  assert.equal(isWholeMessage(log.children[0], target.el), true, 'a call-only message counts as the whole message');
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

  hideAsScan(chat.children[0]);
  assert.ok(invisible(chat.children[0]), 'a result in a role=textbox message container is hidden');
  hideAsScan(chat.children[1]);
  assert.ok(invisible(chat.children[1]), 'a call in a role=textbox message container is hidden too');
  // The draft carries no marker, so the scan never even lands on it — the point is it stays untouched.
  assert.ok(!hidden(chat.children[2]) && !invisible(chat.children[2]), 'a real draft (no message element around it) is never touched');
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

  hideAsScan(main.children[0]);
  assert.ok(invisible(main.children[0]), 'the prefixed result (with its "You said" label) hides whole');
  hideAsScan(main.children[1]);
  assert.ok(invisible(main.children[1]), 'the call still hides');
}

console.log('✔ test_hide_dom: all checks passed');
