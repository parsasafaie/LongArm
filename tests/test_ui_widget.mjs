// Tests for the approval dialog (ui_widget.js): the human gate of every tool call.
// Run / Always allow / Reject, Escape-as-refusal, an unanswered dialog timing out as a refusal,
// the full arguments being shown, and two pending calls queuing in order.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ───────────────────────── A minimal DOM (only what ui_widget.js touches) ─────────────────────────

const TEXT = 3;
const ELEMENT = 1;

class FakeNode {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get nodeType() { return this._nodeType; }
  get parentElement() { return this.parentNode?.nodeType === ELEMENT ? this.parentNode : null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === ELEMENT); }
  get textContent() {
    if (this.nodeType === TEXT) return this.nodeValue;
    return this.childNodes.map((n) => n.textContent).join('');
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.childNodes.push(node); } return this; }
  replaceChildren(...nodes) { this.childNodes = []; return this.append(...nodes); }
  remove() { const at = this.parentNode?.childNodes.indexOf(this) ?? -1; if (at >= 0) this.parentNode.childNodes.splice(at, 1); this.parentNode = null; }
}

class FakeText extends FakeNode {
  constructor(value) { super(); this._nodeType = TEXT; this.nodeValue = value; }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this._nodeType = ELEMENT;
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.classes = new Set();
    this.listeners = new Map();
    this.style = {
      values: new Map(),
      setProperty(name, value, priority) { this.values.set(name, { value, priority: priority ?? '' }); },
      getPropertyValue(name) { return this.values.get(name)?.value ?? ''; },
      getPropertyPriority(name) { return this.values.get(name)?.priority ?? ''; },
      removeProperty(name) { this.values.delete(name); },
    };
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => { const on = force ?? !this.classes.has(name); if (on) this.classes.add(name); else this.classes.delete(name); return on; },
    };
  }
  get id() { return this.attributes.get('id') ?? ''; }
  set id(value) { this.attributes.set('id', String(value)); }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  setAttribute(name, value) { if (name === 'class') this.className = value; else this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  /** Fires the handlers registered for `type` (the tests do not build real Events). */
  fire(type, extra = {}) {
    const event = { target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
    return event;
  }
  attachShadow() { this.shadowRoot = new FakeElement('#shadow-root'); return this.shadowRoot; }
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  matches() { return false; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const document = {
  documentElement: new FakeElement('html'),
  hidden: false,
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (value) => new FakeText(value),
  addEventListener() {},
};
const window = { innerWidth: 1200, innerHeight: 800, addEventListener() {} };
const location = { origin: 'http://example.test', pathname: '/' };
const sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const requestAnimationFrame = (fn) => setTimeout(fn, 0);

// ───────────────────────── Load the widget ─────────────────────────

const context = vm.createContext({
  console, setTimeout, clearTimeout, document, window, location, sessionStorage, requestAnimationFrame,
});
for (const file of ['constants.js', 'ui_widget.js']) {
  vm.runInContext(readFileSync(new URL(`../content_scripts/${file}`, import.meta.url), 'utf8'), context);
}
const { WMB } = context;

const permissions = [];
const widget = new WMB.Widget({
  onRefresh() {},
  onToggleBridge() {},
  onSetPermission: (id, permission) => permissions.push([id, permission]),
});

const call = { server: 'terminal', name: 'run_command', arguments: { command: 'echo hi' } };
const overlay = () => widget.modalLayer.children[0];
const dialog = () => overlay().children[0];
const buttons = () => dialog().children.at(-1).children; // the last row holds Run / Always allow / Reject
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ───────────────────────── 1. Run approves ─────────────────────────

let answer = widget.requestApproval({ ...call });
assert.equal(widget.approvals.length, 1, 'the call is waiting for an answer');
assert.match(dialog().textContent, /terminal › run_command/, 'the dialog names the server and the tool');
buttons()[0].fire('click');
assert.equal(await answer, true, 'Run resolves true');
assert.equal(widget.modalLayer.children.length, 0, 'the dialog closes after the answer');
assert.equal(permissions.length, 0, 'the widget itself never changes a permission');

// ───────────────────────── 2. Always allow resolves with the marker ─────────────────────────

answer = widget.requestApproval({ ...call });
buttons()[1].fire('click');
assert.equal(await answer, 'always', 'Always allow resolves the marker the controller acts on');

// ───────────────────────── 3. Reject refuses ─────────────────────────

answer = widget.requestApproval({ ...call });
buttons()[2].fire('click');
assert.equal(await answer, false, 'Reject resolves false');

// ───────────────────────── 4. Escape refuses (the safe answer) ─────────────────────────

answer = widget.requestApproval({ ...call });
overlay().fire('keydown', { key: 'Escape' });
assert.equal(await answer, false, 'Escape resolves false');

// ───────────────────────── 5. The arguments are shown IN FULL (the human gate) ─────────────────────────

const long = 'x'.repeat(5000);
answer = widget.requestApproval({ server: 'terminal', name: 'run_command', arguments: { command: long } });
const pre = dialog().children[2];
assert.ok(pre.textContent.includes(long), 'a long argument is shown complete, not truncated');
buttons()[0].fire('click');
await answer;

// ───────────────────────── 6. A dialog nobody answers times out as a refusal ─────────────────────────

const saved = WMB.defaults.timeouts.approval;
WMB.defaults.timeouts.approval = 40;
answer = widget.requestApproval({ ...call });
assert.equal(await answer, false, 'an unanswered dialog resolves as a refusal');
assert.ok(widget.logs.some((entry) => /No answer/.test(entry.text)), 'and the log says why');
assert.equal(widget.modalLayer.children.length, 0, 'the dialog is closed');
WMB.defaults.timeouts.approval = saved;

// ───────────────────────── 7. Two pending calls queue in order ─────────────────────────

const first = widget.requestApproval({ server: 'terminal', name: 'first', arguments: {} });
const second = widget.requestApproval({ server: 'terminal', name: 'second', arguments: {} });
assert.equal(widget.approvals.length, 2);
assert.match(dialog().textContent, /terminal › first/, 'the first call is on screen');
assert.match(widget.root.textContent, /2 calls pending approval/, 'the pill shows both calls waiting');
buttons()[0].fire('click');
assert.equal(await first, true, 'the first is answered');
await settle();
assert.match(dialog().textContent, /terminal › second/, 'the second dialog is shown next');
buttons()[0].fire('click');
assert.equal(await second, true, 'the second is answered');
assert.equal(widget.approvals.length, 0);
assert.equal(widget.modalLayer.children.length, 0);

console.log('✔ test_ui_widget: all checks passed');
