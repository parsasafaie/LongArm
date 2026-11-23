// Tests for RequestLifecycle State Machine and structured JSON output standard.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  location: { pathname: '/chat/123', hostname: 'chatgpt.com' },
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
});

for (const file of [
  'content_scripts/constants.js',
  'content_scripts/utils.js',
  'content_scripts/hide.js',
  'content_scripts/call_registry.js',
]) {
  vm.runInContext(read(file), context);
}

const { WMB } = context;

// 1. UUID uniqueness and format
const id1 = WMB.generateUuid();
const id2 = WMB.generateUuid();
assert.equal(typeof id1, 'string');
assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
assert.notEqual(id1, id2);

// 2. State Machine: 'completed'
const call = { server: 'terminal', name: 'run', arguments: { command: 'echo hello' } };
const reqCompleted = new WMB.RequestLifecycle(call);
assert.equal(reqCompleted.state, 'queued');
reqCompleted.start();
assert.equal(reqCompleted.state, 'running');
assert.ok(reqCompleted.startedAt);
reqCompleted.finish({
  state: 'completed',
  stdout: 'hello\n',
  stderr: '',
  exitCode: 0,
  durationMs: 125,
  cached: false,
});
assert.equal(reqCompleted.state, 'completed');

const json1 = reqCompleted.toJSON();
assert.equal(json1.request_id, reqCompleted.id);
assert.equal(json1.status, 'completed');
assert.equal(json1.execution.duration_ms, 125);
assert.equal(json1.result.stdout, 'hello\n');
assert.equal(json1.result.stderr, '');
assert.equal(json1.result.exit_code, 0);
assert.equal(json1.cached, false);

// 3. State Machine: 'failed'
const reqFailed = new WMB.RequestLifecycle(call);
reqFailed.start();
reqFailed.finish({
  state: 'failed',
  stdout: '',
  stderr: 'Command not found',
  exitCode: 1,
  durationMs: 45,
});
const json2 = reqFailed.toJSON();
assert.equal(json2.status, 'failed');
assert.equal(json2.result.exit_code, 1);
assert.equal(json2.result.stderr, 'Command not found');
assert.equal(json2.cached, false);

// 4. State Machine: 'timeout'
const reqTimeout = new WMB.RequestLifecycle(call);
reqTimeout.start();
reqTimeout.finish({
  state: 'timeout',
  stdout: '',
  stderr: 'Command timed out after 30s',
  exitCode: 124,
  durationMs: 30000,
});
const json3 = reqTimeout.toJSON();
assert.equal(json3.status, 'timeout');
assert.equal(json3.result.exit_code, 124);
assert.equal(json3.cached, false);

// 5. State Machine: 'cancelled'
const reqCancelled = new WMB.RequestLifecycle(call);
reqCancelled.start();
reqCancelled.finish({
  state: 'cancelled',
  stdout: '',
  stderr: 'The user does not allow this tool to run in this chat.',
  exitCode: 126,
  durationMs: 5,
});
const json4 = reqCancelled.toJSON();
assert.equal(json4.status, 'cancelled');
assert.equal(json4.result.exit_code, 126);

// 6. Formatting inside [MCP_RESULT ...] and hide.js compatibility
const jsonText = JSON.stringify(json1, null, 2);
const plan = WMB.planResult({ content: [{ type: 'text', text: jsonText }] }, { server: 'terminal', name: 'run', status: 'ok' });
const builtMessage = plan.build(true);
assert.ok(builtMessage.includes('[MCP_RESULT server="terminal" tool="run" status="ok"]'));
assert.ok(builtMessage.includes(`"request_id": "${reqCompleted.id}"`));
assert.ok(builtMessage.includes('"status": "completed"'));
assert.ok(builtMessage.includes('[/MCP_RESULT]'));
assert.equal(WMB.isBridgeMessage(builtMessage), true, 'hide.js recognizes and hides standard JSON result message');

// 7. Duplicate Caching with cached: true
const registry = new WMB.CallRegistry({ windowMs: 15_000, max: 1 });
const repeatKey = registry.key(call.server, call.name, call.arguments);
assert.equal(registry.repeats(repeatKey), 0);

// Record initial run
registry.record(repeatKey, { status: 'ok', raw: { content: [{ type: 'text', text: jsonText }] } }, 1);
assert.equal(registry.repeats(repeatKey), 1);

// Second identical call within window
const reqCached = new WMB.RequestLifecycle(call);
reqCached.start();
const cachedEntry = registry.lastResult(repeatKey);
const prev = JSON.parse(cachedEntry.raw.content[0].text);
reqCached.finish({
  state: prev.status,
  stdout: prev.result.stdout,
  stderr: prev.result.stderr,
  exitCode: prev.result.exit_code,
  durationMs: 0,
  cached: true,
});
const cachedJson = reqCached.toJSON();
assert.equal(cachedJson.status, 'completed');
assert.equal(cachedJson.cached, true, 'cached flag is true for duplicate call');
assert.notEqual(cachedJson.request_id, prev.request_id, 'each call gets a unique request_id even when cached');

// Clear registry (e.g. on new user message turn)
registry.clear();
assert.equal(registry.repeats(repeatKey), 0, 'registry cleared on user action');

console.log('✔ test_lifecycle: all lifecycle state machine and JSON standard checks passed');
