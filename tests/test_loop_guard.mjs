import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  Date,
  Set,
  Map,
  WeakMap,
  JSON,
});

vm.runInContext(read('content_scripts/constants.js'), context);
vm.runInContext(read('content_scripts/utils.js'), context);
vm.runInContext(read('content_scripts/call_registry.js'), context);

const { WMB } = context;

// Verify CallRegistry window and bump behavior
const registry = new WMB.CallRegistry({ windowMs: 15_000, max: 1 });
const key = registry.key('terminal', 'run_command', { command: 'echo test' });

assert.equal(registry.repeats(key), 0, 'Initially 0 repeats');

// First execution recorded
registry.record(key, { status: 'ok', text: 'result 1' });
assert.equal(registry.repeats(key), 1, 'First run gives repeat count 1');

// Replay bumps count without extending window indefinitely
registry.bump(key);
assert.equal(registry.repeats(key), 2, 'First replay bumps repeat count to 2');

registry.bump(key);
assert.equal(registry.repeats(key), 3, 'Second replay bumps repeat count to 3');

// Clear resets
registry.clear();
assert.equal(registry.repeats(key), 0, 'Clear resets repeat count to 0');

console.log('✔ test_loop_guard: registry loop guard logic passed');
