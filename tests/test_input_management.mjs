// Tests for Chat Input management, delivery, and post-send clearing in LongArm.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

class MockElement {
  constructor(tag = 'div', isContentEditable = true) {
    this.tagName = tag.toUpperCase();
    this.isContentEditable = isContentEditable;
    this._text = '';
    this.children = [];
  }
  get innerText() { return this._text; }
  set innerText(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  focus() {}
  replaceChildren() { this.children = []; this._text = ''; }
  append(child) { this.children.push(child); if (child?._text) this._text += child._text; }
  dispatchEvent() { return true; }
}

class MockInputControl extends MockElement {
  constructor(tag) {
    super(tag, false);
    this._value = '';
  }
  get value() { return this._value; }
  set value(v) { this._value = String(v); this._text = this._value; }
}

const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  HTMLTextAreaElement: class extends MockInputControl { constructor() { super('textarea'); } },
  HTMLInputElement: class extends MockInputControl { constructor() { super('input'); } },
  Event: class { constructor(type) { this.type = type; } },
  InputEvent: class { constructor(type) { this.type = type; } },
  ClipboardEvent: class { constructor(type) { this.type = type; } },
  KeyboardEvent: class { constructor(type) { this.type = type; } },
  DataTransfer: class {
    constructor() { this.data = new Map(); }
    setData(k, v) { this.data.set(k, v); }
    getData(k) { return this.data.get(k); }
  },
  document: {
    createElement: (tag) => new MockElement(tag),
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand: () => true,
    hidden: false,
    hasFocus: () => true,
  },
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  window: {
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  },
});

for (const file of [
  'content_scripts/constants.js',
  'content_scripts/utils.js',
  'content_scripts/adapters/base_adapter.js',
]) {
  vm.runInContext(read(file), context);
}

const { WMB } = context;

// 1. dom.clearText on textarea
const textarea = new context.HTMLTextAreaElement();
textarea.value = '[MCP_RESULT server="terminal" tool="run_command"]output[/MCP_RESULT]';
assert.equal(WMB.dom.getText(textarea), '[MCP_RESULT server="terminal" tool="run_command"]output[/MCP_RESULT]');
await WMB.dom.clearText(textarea);
assert.equal(WMB.dom.getText(textarea), '', 'textarea cleared completely');

// 2. dom.clearText on contenteditable div
const div = new MockElement('div', true);
div.textContent = '[MCP_RESULT server="terminal" tool="run_command"]output[/MCP_RESULT]';
assert.ok(WMB.dom.getText(div).includes('[MCP_RESULT'));
await WMB.dom.clearText(div);
assert.equal(WMB.dom.getText(div).trim(), '', 'contenteditable div cleared completely');

// 3. sendToolResult lifecycle: write -> submit -> confirm -> clear
class MockAdapter extends WMB.BaseAdapter {
  constructor(composer) {
    super({
      id: 'mock',
      name: 'MockAdapter',
      selectors: { composer: ['#composer'], sendButton: ['#send'], assistantMessages: ['.msg'], stopButton: [] },
    });
    this.composer = composer;
    this.submitted = false;
    this.streaming = false;
  }
  matches() { return true; }
  getComposer() { return this.composer; }
  getSendButton() {
    return {
      disabled: false,
      getAttribute: () => null,
      click: () => {
        this.submitted = true;
        // Simulate chat accepting the send by starting response streaming
        this.streaming = true;
      },
    };
  }
  isStreaming() { return this.streaming; }
}

const composerEl = new context.HTMLTextAreaElement();
const adapter = new MockAdapter(composerEl);

// Deliver Result 1
const result1 = '[MCP_RESULT server="terminal" tool="run_command" status="ok"]\nResult 1\n[/MCP_RESULT]';
const send1 = await adapter.sendToolResult(result1, { autoSend: true });
assert.ok(send1.ok, 'sendToolResult succeeded');
assert.ok(adapter.submitted, 'submit was triggered');
assert.equal(WMB.dom.getText(composerEl), '', 'composer is empty after successful send');

// Deliver Result 2 sequentially
adapter.submitted = false;
adapter.streaming = false;
const result2 = '[MCP_RESULT server="terminal" tool="run_command" status="ok"]\nResult 2\n[/MCP_RESULT]';
const send2 = await adapter.sendToolResult(result2, { autoSend: true });
assert.ok(send2.ok, 'second sendToolResult succeeded');
assert.ok(adapter.submitted, 'second submit was triggered');
assert.equal(WMB.dom.getText(composerEl), '', 'composer is empty after second send');
assert.ok(!WMB.dom.getText(composerEl).includes('Result 1'), 'Result 1 was not concatenated');

// 4. If send is NOT confirmed, text must NOT be cleared (Rule 5)
const failingAdapter = new MockAdapter(composerEl);
failingAdapter.submit = async () => false; // Simulate submit failure
const result3 = '[MCP_RESULT server="terminal" tool="run_command" status="ok"]\nResult 3\n[/MCP_RESULT]';

const send3 = await failingAdapter.sendToolResult(result3, { autoSend: true });
assert.equal(send3.ok, false, 'send failed as expected');
assert.ok(WMB.dom.getText(composerEl).includes('Result 3'), 'text is preserved when send is not confirmed');

// 5. The user's draft is never destroyed by a result.
const draftComposer = new context.HTMLTextAreaElement();
draftComposer.value = 'my half-written prompt';
const draftAdapter = new MockAdapter(draftComposer);
const draftResult = '[MCP_RESULT server="terminal" tool="run_command" status="ok"]\nDraft result\n[/MCP_RESULT]';
const draftSend = await draftAdapter.sendToolResult(draftResult, { autoSend: true });
assert.ok(draftSend.ok, 'the result was sent');
assert.equal(draftSend.draftRestored, true, 'the send path reports the draft restore');
assert.equal(WMB.dom.getText(draftComposer).trim(), 'my half-written prompt', 'the draft is back after the send');

// With autoSend=false the result is staged BELOW the draft: neither is lost.
const stagedComposer = new context.HTMLTextAreaElement();
stagedComposer.value = 'keep me';
const stagedAdapter = new MockAdapter(stagedComposer);
const staged = await stagedAdapter.sendToolResult(draftResult, { autoSend: false });
assert.equal(staged.staged, true);
const stagedText = WMB.dom.getText(stagedComposer);
assert.ok(stagedText.includes('keep me') && stagedText.includes('Draft result'), 'draft and staged result coexist');

// 6. A short remainder in the composer is NOT proof of a send (the old `length < 10` rule lied).
const shortComposer = new context.HTMLTextAreaElement();
const shortAdapter = new MockAdapter(shortComposer);
shortAdapter.submit = async () => true; // the click "worked", but the chat never took the text
const savedWaitFor = WMB.waitFor;
WMB.waitFor = async (fn) => fn() || false; // no 8 s waits: the composer is found, the confirmation is not
const shortResult = '[MCP_RESULT server="terminal" tool="run_command" status="ok"]\nok\n[/MCP_RESULT]';
const shortSend = await shortAdapter.sendToolResult(shortResult, { autoSend: true });
WMB.waitFor = savedWaitFor;
assert.equal(shortSend.ok, false, 'a short unsent text is not a confirmed send');
assert.ok(WMB.dom.getText(shortComposer).includes('MCP_RESULT'), 'and the result is not cleared');

// 7. Text typed WHILE the send is in flight is never wiped by the clear/draft restore.
class TypingAdapter extends MockAdapter {
  async submit() {
    this.composer.value = 'typed while the result was sending';
    this.streaming = true;
    return true;
  }
}
const typingComposer = new context.HTMLTextAreaElement();
const typingAdapter = new TypingAdapter(typingComposer);
const typingSend = await typingAdapter.sendToolResult(draftResult, { autoSend: true });
assert.equal(typingSend.ok, true, 'the send itself is confirmed');
assert.equal(typingComposer.value, 'typed while the result was sending', 'the text typed during the send survives');

// 8. A generation that was ALREADY running before the send is not proof that OUR message was accepted.
class AlreadyStreamingAdapter extends MockAdapter {
  isStreaming() { return true; }
  async submit() { return true; } // the click/Enter does not actually send anything
}
const streamingComposer = new context.HTMLTextAreaElement();
const streamingAdapter = new AlreadyStreamingAdapter(streamingComposer);
const savedWait = WMB.waitFor;
WMB.waitFor = async (fn) => fn() || false; // no 10 s waits in the test
const streamingSend = await streamingAdapter.sendToolResult(draftResult, { autoSend: true });
WMB.waitFor = savedWait;
assert.equal(streamingSend.ok, false, 'an old stream must not confirm the send');
assert.ok(WMB.dom.getText(streamingComposer).includes('MCP_RESULT'), 'and the result is not cleared');

console.log('✔ test_input_management: all input state, confirmation, and clearing checks passed');
