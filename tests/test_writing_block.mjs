import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// DOM elements setup for mock environment
class MockElement {
  constructor(tag, id = '', className = '', attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = className;
    this.classList = {
      contains: (c) => this.className.split(/\s+/).includes(c),
    };
    this.attrs = { ...attrs };
    if (id) this.attrs.id = id;
    this.children = [];
    this.parentElement = null;
    this.value = '';
    this._textContent = '';
    this.offsetWidth = 100;
    this.offsetHeight = 30;
  }

  get textContent() {
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join('\n');
    }
    return this._textContent;
  }
  set textContent(v) {
    this.children = [];
    this._textContent = String(v ?? '');
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }

  append(...nodes) {
    for (const n of nodes) {
      n.parentElement = this;
      this.children.push(n);
      if (n.textContent) this._textContent = (this._textContent ? this._textContent + '\n' : '') + n.textContent;
    }
  }

  appendChild(n) {
    this.append(n);
    return n;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  matches(sel) {
    if (sel === '#prompt-textarea' && (this.id === 'prompt-textarea' || this.attrs.id === 'prompt-textarea')) return true;
    if (sel.includes('.ProseMirror') && this.classList.contains('ProseMirror')) return true;
    if (sel.includes('[contenteditable="true"]') && this.attrs.contenteditable === 'true') return true;
    if (sel.startsWith('form') && this.tagName === 'FORM') return true;
    if (sel.includes('[data-testid="send-button"]') && this.attrs['data-testid'] === 'send-button') return true;
    return false;
  }

  closest(sel) {
    let curr = this;
    while (curr) {
      if (typeof sel === 'string') {
        const parts = sel.split(',').map(s => s.trim());
        for (const p of parts) {
          if (p === 'form' && curr.tagName === 'FORM') return curr;
          if (p === 'aside' && curr.tagName === 'ASIDE') return curr;
          if (p === 'article' && curr.tagName === 'ARTICLE') return curr;
          if (p === '[role="region"]' && curr.attrs.role === 'region') return curr;
          if (p.includes('canvas') && (curr.className.includes('canvas') || (curr.attrs['data-testid'] || '').includes('canvas'))) return curr;
          if (p.includes('artifact') && (curr.className.includes('artifact') || (curr.attrs['data-testid'] || '').includes('artifact'))) return curr;
          if (p.includes('document') && (curr.className.includes('document') || (curr.attrs['data-testid'] || '').includes('document'))) return curr;
        }
      }
      curr = curr.parentElement;
    }
    return null;
  }

  querySelectorAll(sel) {
    const res = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(sel)) res.push(child);
        walk(child);
      }
    };
    walk(this);
    return res;
  }

  querySelector(sel) {
    const list = this.querySelectorAll(sel);
    return list[0] ?? null;
  }

  focus() {
    mockDocument.activeElement = this;
  }
  blur() {
    if (mockDocument.activeElement === this) mockDocument.activeElement = null;
  }
  dispatchEvent() { return true; }
}

const rootDoc = new MockElement('HTML');
const body = new MockElement('BODY');
rootDoc.append(body);

const mockDocument = {
  body,
  activeElement: null,
  hidden: false,
  hasFocus: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: (tag) => new MockElement(tag),
  createRange: () => ({ selectNodeContents() {}, collapse() {} }),
  getSelection: () => null,
  getElementById: (id) => {
    const all = rootDoc.querySelectorAll('*');
    return all.find(e => e.id === id) ?? null;
  },
  querySelectorAll: (sel) => rootDoc.querySelectorAll(sel),
  querySelector: (sel) => rootDoc.querySelector(sel),
};

const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  Date,
  Set,
  Map,
  WeakMap,
  WeakSet,
  Proxy,
  Element: MockElement,
  Event: class { constructor(type) { this.type = type; } },
  InputEvent: class { constructor(type) { this.type = type; } },
  ClipboardEvent: class { constructor(type) { this.type = type; } },
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4 },
  document: mockDocument,
  window: { addEventListener: () => {}, removeEventListener: () => {} },
  MutationObserver: class { observe() {} disconnect() {} },
  location: { pathname: '/c/test-chat', hostname: 'chatgpt.com', href: 'https://chatgpt.com/c/test-chat' },
});

vm.runInContext(read('content_scripts/constants.js'), context);
vm.runInContext(read('content_scripts/utils.js'), context);
vm.runInContext(read('content_scripts/mcp_parser.js'), context);
vm.runInContext(read('content_scripts/adapters/base_adapter.js'), context);
vm.runInContext('globalThis.WMB.adapters = []; globalThis.WMB.registerAdapter = (a) => globalThis.WMB.adapters.push(a);', context);
vm.runInContext(read('content_scripts/adapters/chatgpt.js'), context);

const adapter = context.WMB.findAdapter('chatgpt.com');
assert.ok(adapter, 'ChatGPT adapter found');

// TEST 1: Chat without Writing Block
// Standard chat form with #prompt-textarea and send button
const chatForm = new MockElement('FORM', 'chat-form');
const chatComposer = new MockElement('DIV', 'prompt-textarea', 'ProseMirror', { contenteditable: 'true' });
const sendButton = new MockElement('BUTTON', '', '', { 'data-testid': 'send-button' });
chatForm.append(chatComposer, sendButton);
body.append(chatForm);

assert.equal(adapter.getComposer(), chatComposer, 'Test 1: Finds main chat composer in normal chat');

// TEST 2: Chat WITH 1 Writing Block (Canvas / Artifact)
// Canvas side-panel with its own ProseMirror contenteditable
const canvasPanel = new MockElement('ASIDE', 'canvas-panel', 'canvas-container', { 'data-testid': 'canvas-editor' });
const canvasEditor = new MockElement('DIV', 'canvas-pm', 'ProseMirror', { contenteditable: 'true' });
canvasEditor.textContent = 'User original draft in canvas';
canvasPanel.append(canvasEditor);
body.append(canvasPanel);

// Check isWritingBlock
assert.equal(adapter.isWritingBlock(canvasEditor), true, 'Test 2a: Canvas editor is recognized as a writing block');
assert.equal(adapter.isWritingBlock(chatComposer), false, 'Test 2b: Main chat composer is NOT a writing block');

// Check that getComposer() still returns the chatComposer, NOT canvasEditor
const selected = adapter.getComposer();
assert.equal(selected, chatComposer, 'Test 2c: getComposer() strictly ignores canvas writing block and picks chat composer');

// TEST 3: Multiple Writing Blocks (e.g. Canvas + Document Editor)
const docPanel = new MockElement('DIV', 'doc-panel', 'editor-panel', { 'data-testid': 'document-editor' });
const docEditor = new MockElement('DIV', 'doc-pm', 'ProseMirror', { contenteditable: 'true' });
docEditor.textContent = 'Second document content';
docPanel.append(docEditor);
body.append(docPanel);

assert.equal(adapter.isWritingBlock(docEditor), true, 'Test 3a: Second doc editor is recognized as a writing block');
assert.equal(adapter.getComposer(), chatComposer, 'Test 3b: getComposer() still strictly chooses chat composer with multiple writing blocks');

// TEST 4: Writing Block in edit mode / focused
canvasEditor.attrs['data-focused'] = 'true';
assert.equal(adapter.getComposer(), chatComposer, 'Test 4: Even with writing block in active edit mode, chat composer is selected');

// TEST 5: Verify canvas text remains untouched
assert.equal(canvasEditor.textContent, 'User original draft in canvas', 'Test 5a: Canvas draft text untouched');
assert.equal(docEditor.textContent, 'Second document content', 'Test 5b: Doc draft text untouched');

// TEST 6: If main chat composer is missing completely, sendMessage refuses to write to Writing Block
// Remove chatForm
body.children = body.children.filter(c => c !== chatForm);

const sendResult = await adapter.sendMessage('test payload', { autoSend: false });
assert.equal(sendResult.ok, false, 'Test 6a: sendMessage fails safely when only writing blocks exist');
assert.match(sendResult.error, /writing block/i, 'Test 6b: Error specifies writing blocks are excluded');
assert.equal(canvasEditor.textContent, 'User original draft in canvas', 'Test 6c: Canvas draft text remains completely untouched');
assert.equal(docEditor.textContent, 'Second document content', 'Test 6d: Doc draft text remains completely untouched');

// TEST 7: Direct dom.setText invocation on a Writing Block MUST abort and return false
const directSetResult = await context.WMB.dom.setText(canvasEditor, 'malicious direct write');
assert.equal(directSetResult, false, 'Test 7a: Direct setText on writing block is strictly rejected');
assert.equal(canvasEditor.textContent, 'User original draft in canvas', 'Test 7b: Canvas text completely preserved');

// TEST 8: Direct dom.clearText invocation on a Writing Block MUST abort
await context.WMB.dom.clearText(canvasEditor);
assert.equal(canvasEditor.textContent, 'User original draft in canvas', 'Test 8: clearText strictly protects writing block from clearing');

// TEST 9: Writing to chat composer while Writing Block has active browser focus
// Re-add chatForm
body.append(chatForm);
canvasEditor.focus();
assert.equal(mockDocument.activeElement, canvasEditor, 'Canvas editor is currently activeElement');

const chatWriteSuccess = await context.WMB.dom.setText(chatComposer, 'Result message [MCP_RESULT]');
assert.equal(chatWriteSuccess, true, 'Test 9a: Text successfully written to chat composer');
assert.equal(chatComposer.textContent.includes('Result message [MCP_RESULT]'), true, 'Test 9b: Chat composer received the result text');
assert.equal(canvasEditor.textContent, 'User original draft in canvas', 'Test 9c: Writing block draft is 100% untouched despite having had activeElement focus');

console.log('✔ test_writing_block: all Writing Block protection and isolation tests passed');
