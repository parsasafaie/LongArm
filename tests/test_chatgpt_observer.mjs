import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Set up VM context mimicking browser for chatgpt.js
const mockElements = [];
const documentMock = {
  hidden: false,
  hasFocus: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
  body: {
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  querySelectorAll: (selector) => {
    if (selector === 'pre') {
      return mockElements.filter(e => e.tagName === 'PRE');
    }
    return [];
  },
  querySelector: (selector) => null,
  createTreeWalker: () => ({ nextNode: () => null }),
};

class MockMutationObserver {
  observe() {}
  disconnect() {}
}

const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  Date,
  Set,
  Map,
  WeakMap,
  Proxy,
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4 },
  NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  document: documentMock,
  window: { addEventListener: () => {}, removeEventListener: () => {} },
  MutationObserver: MockMutationObserver,
  location: { pathname: '/c/test-chat', href: 'https://chatgpt.com/c/test-chat' },
});

vm.runInContext(read('content_scripts/constants.js'), context);
vm.runInContext(read('content_scripts/utils.js'), context);
vm.runInContext(read('content_scripts/mcp_parser.js'), context);
vm.runInContext(read('content_scripts/adapters/base_adapter.js'), context);
vm.runInContext('globalThis.WMB.adapters = []; globalThis.WMB.registerAdapter = (a) => globalThis.WMB.adapters.push(a);', context);
vm.runInContext(read('content_scripts/adapters/chatgpt.js'), context);

const adapter = context.WMB.findAdapter('chatgpt.com');
assert.ok(adapter, 'ChatGPT adapter registered');

// Test 1: During baseline, calls are indexed and callback is not fired
let fired = [];
const unobserve = adapter.observeResponses((detected) => {
  fired.push(detected);
});

// Create a pre element containing a valid call
function createPre(text) {
  return {
    tagName: 'PRE',
    nodeType: 1,
    childNodes: [{ nodeType: 3, nodeValue: text }],
    textContent: text,
    closest: () => null,
    querySelector: () => null,
    contains: () => false,
    matches: (s) => s === 'pre',
    compareDocumentPosition: () => 0,
    classList: { contains: () => false },
  };
}

const callPre = createPre('{"mcp_call": {"server": "terminal", "name": "run_command", "arguments": {"command": "echo baseline"}}}');
mockElements.push(callPre);

// Trigger rescan while in baseline
adapter.rescan();
assert.equal(fired.length, 0, 'In baseline period, old calls are not executed');

// Test 2: After baseline ends, a NEW call IS executed
adapter.baselineUntil = 0; // Simulate baseline expired / user activity
adapter.markActivity();   // the user sent a message: the next reply is a live turn
const newCallPre = createPre('{"mcp_call": {"server": "terminal", "name": "run_command", "arguments": {"command": "echo new_call"}}}');
mockElements.push(newCallPre);

adapter.rescan();

const now = Date.now();
context.Date.now = () => now + 2000;

adapter.rescan();


assert.equal(fired.length, 1, 'New call after baseline was executed!');
assert.equal(fired[0].call.name, 'run_command');
assert.equal(fired[0].call.arguments.command, 'echo new_call');

// Test 3: Verify that the SAME executed element is NEVER re-executed on subsequent scans (Bug 1 fix)
// Simulate tool delivery
adapter.deliveries += 1;
adapter.lastDeliveryAt = Date.now();
adapter.genSinceDelivery = true; // Even if generation is marked
if (typeof adapter.onDelivery === 'function') adapter.onDelivery();

// Run multiple scans
adapter.rescan();
context.Date.now = () => now + 4000;
adapter.rescan();
context.Date.now = () => now + 6000;
adapter.rescan();

assert.equal(fired.length, 1, 'Bug 1 Fix: Executed element must NEVER re-fire on subsequent scans!');

unobserve();
console.log('✔ test_chatgpt_observer: baseline indexing, execution, and duplicate suppression verification passed');
