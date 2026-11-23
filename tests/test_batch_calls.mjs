// Tests for batch and sequential multi-tool calls support in LongArm.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  location: { pathname: '/chat/123', hostname: 'gemini.google.com' },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  document: {
    body: {},
    hidden: false,
    hasFocus: () => true,
    addEventListener() {},
    removeEventListener() {},
  },
  window: {
    addEventListener() {},
    removeEventListener() {},
  },
  sessionStorage: {
    data: new Map(),
    getItem(k) { return this.data.get(k) ?? null; },
    setItem(k, v) { this.data.set(k, String(v)); },
    removeItem(k) { this.data.delete(k); },
    clear() { this.data.clear(); },
  },
});

for (const file of [
  'content_scripts/constants.js',
  'content_scripts/utils.js',
  'content_scripts/mcp_parser.js',
  'content_scripts/prompt_builder.js',
  'content_scripts/hide.js',
  'content_scripts/call_registry.js',
  'content_scripts/adapters/base_adapter.js',
]) {
  vm.runInContext(read(file), context);
}

const { WMB } = context;

// ───────────────────────── 1. Extraction of multiple calls ─────────────────────────

const rawMultiLine = `
\`\`\`json
{"mcp_call":{"server":"terminal","name":"run_command","arguments":{"command":"git status"}}}
{"mcp_call":{"server":"terminal","name":"run_command","arguments":{"command":"git branch"}}}
\`\`\`
`;

const calls1 = WMB.extractMcpCalls(rawMultiLine);
assert.equal(calls1.length, 2, 'extracts 2 newline-separated calls');
assert.equal(calls1[0].arguments.command, 'git status');
assert.equal(calls1[1].arguments.command, 'git branch');

const rawArray = `
\`\`\`json
[
  {"mcp_call":{"server":"terminal","name":"run_command","arguments":{"command":"echo 1"}}},
  {"mcp_call":{"server":"terminal","name":"run_command","arguments":{"command":"echo 2"}}},
  {"mcp_call":{"server":"terminal","name":"run_command","arguments":{"command":"echo 3"}}}
]
\`\`\`
`;

const calls2 = WMB.extractMcpCalls(rawArray);
assert.equal(calls2.length, 3, 'extracts 3 calls from a JSON array');
assert.equal(calls2[0].arguments.command, 'echo 1');
assert.equal(calls2[1].arguments.command, 'echo 2');
assert.equal(calls2[2].arguments.command, 'echo 3');

// ───────────────────────── 2. Hiding multi-call AI text & multi-result messages ─────────────────────────

// AI pure call detection
assert.equal(WMB.isPureCall(rawMultiLine), true, 'newline-separated multi-call is detected as a pure call');
assert.equal(WMB.isPureCall(rawArray), true, 'JSON array multi-call is detected as a pure call');

// Mixed prose with call is NOT pure
const proseWithCalls = `Here are the commands to run:\n${rawMultiLine}`;
assert.equal(WMB.isPureCall(proseWithCalls), false, 'calls surrounded by prose are not treated as pure calls');

// Multi-result message detection
const multiResultText = `
[MCP_RESULT server="terminal" tool="run_command" status="ok"]
On branch main
[/MCP_RESULT]

[MCP_RESULT server="terminal" tool="run_command" status="ok"]
* main
  feature-1
[/MCP_RESULT]
`.trim();

assert.equal(WMB.isBridgeMessage(multiResultText), true, 'combined multi-result message is hidden whole');
assert.equal(WMB.isBridgeMessage(`You said\n${multiResultText}`), true, 'a rendered label in front still identifies the result as bridge text');
const ranges = WMB.planHiddenRanges(multiResultText);
assert.equal(ranges.length, 1, 'ranges cover the combined multi-result message');

// ───────────────────────── 3. Multi-result planning & combination ─────────────────────────

const plan1 = WMB.planResult({ content: [{ type: 'text', text: 'Output 1' }] }, { server: 'terminal', name: 'run_command', status: 'ok' });
const plan2 = WMB.planResult({ content: [{ type: 'text', text: 'Output 2' }] }, { server: 'terminal', name: 'run_command', status: 'ok' });

const combinedMessage = [plan1.build(true), plan2.build(true)].join('\n\n');
assert.ok(combinedMessage.includes('[MCP_RESULT server="terminal" tool="run_command" status="ok"]\nOutput 1\n[/MCP_RESULT]'));
assert.ok(combinedMessage.includes('[MCP_RESULT server="terminal" tool="run_command" status="ok"]\nOutput 2\n[/MCP_RESULT]'));
assert.equal(WMB.isBridgeMessage(combinedMessage), true, 'built multi-result string passes bridge message check');

// ───────────────────────── 4. BaseAdapter multi-call callback delivery ─────────────────────────

class TestAdapter extends WMB.BaseAdapter {
  constructor() {
    super({
      id: 'test',
      name: 'TestAdapter',
      selectors: {
        composer: ['textarea'],
        sendButton: ['button.send'],
        assistantMessages: ['.assistant'],
        stopButton: ['button.stop'],
      },
    });
    this.messages = [];
  }
  matches() { return true; }
  getAssistantMessages() { return this.messages; }
  isStreaming() { return false; }
}

const adapter = new TestAdapter();
adapter.messages = [];
// A real send arms the turn: the next assistant reply is live. (Zeroing the baseline is no longer enough — that
// would make restored history run, which is exactly the bug this gate exists for.)
adapter.markActivity();
adapter.messages = [{ textContent: rawMultiLine, closest: () => null, getAttribute: () => null }];
let received = null;
const stop = adapter.observeResponses((detected) => {
  received = detected;
});

// Skip baseline window after observeResponses set it
adapter.baselineUntil = 0;
adapter.markActivity();
adapter.turnStartMsgs = 0;

// Rescan
adapter.rescan();

assert.ok(received, 'adapter triggered callback');
assert.equal(received.calls?.length, 2, 'adapter passes all 2 calls in detected.calls');
assert.equal(received.calls[0].arguments.command, 'git status');
assert.equal(received.calls[1].arguments.command, 'git branch');
stop();

// ───────────────────────── 5. Same-length content change is detected ─────────────────────────
// The scan signature used only text.length: a repaint that swapped the text for another one of the SAME
// length never reached the parser, so the new call was silently missed.
const sigAdapter = new TestAdapter();
const historyMsg = { textContent: 'history', closest: () => null, getAttribute: () => null };
const msg = (text) => ({ textContent: text, closest: () => null, getAttribute: () => null });
sigAdapter.messages = [historyMsg];
sigAdapter.markActivity();
sigAdapter.messages = [historyMsg, msg('x'.repeat(300))];
const sigDetected = [];
const stopSig = sigAdapter.observeResponses((detected) => { sigDetected.push(detected); });
sigAdapter.baselineUntil = 0;
sigAdapter.markActivity();
sigAdapter.turnStartMsgs = 1; // message #1 (the reply) is the live one
sigAdapter.rescan(); // memorise the no-call text (length 300)
const sameLengthCall = JSON.stringify({ mcp_call: { server: 'terminal', name: 'run_command', arguments: { command: 'echo same' } } }).padEnd(300, ' ');
sigAdapter.messages = [historyMsg, msg(sameLengthCall)];
sigAdapter.rescan();
assert.equal(sigDetected.length, 1, 'a same-length change is detected (content hash, not length)');
stopSig();

// ───────────────────────── 6. The in-memory ledger stays bounded ─────────────────────────
// sessionStorage was capped at 500 while the live Sets grew without limit in a long-lived tab.
for (let i = 0; i < 2000; i += 1) adapter.rememberExecuted(`exec-${i}`);
for (let i = 0; i < 2000; i += 1) adapter.markDelivered([`del-${i}`]);
assert.ok(adapter.executed.size <= 500, `executed Set trimmed (got ${adapter.executed.size})`);
assert.ok(adapter.delivered.size <= 500, `delivered Set trimmed (got ${adapter.delivered.size})`);

// ───────────────────────── 7. Positional ids are content keys on sites without message ids ─────────────────────────
const keyAdapter = new TestAdapter();
const keyEl = (text) => ({ textContent: text, closest: () => null, getAttribute: () => null });
keyAdapter.messages = [keyEl('same text'), keyEl('same text')];
const key0 = keyAdapter.getMessageKey(keyAdapter.messages[0], 0);
const key1 = keyAdapter.getMessageKey(keyAdapter.messages[1], 1);
assert.notEqual(key0, key1, 'two identical messages still get distinct keys (occurrence counted)');
// Re-rendering the thread with an extra message BEFORE them must not rename the call (their relative order
// among identical texts is what counts, not the absolute index).
keyAdapter.messages = [keyEl('a new earlier message'), keyEl('same text'), keyEl('same text')];
assert.equal(keyAdapter.getMessageKey(keyAdapter.messages[1], 1), key0, 'the key does not depend on the absolute position');
assert.equal(keyAdapter.getMessageKey(keyAdapter.messages[2], 2), key1, 'and the duplicate keeps its occurrence');

console.log('✔ test_batch_calls: all batch and multi-call tests passed');
