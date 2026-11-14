// Tests for the ONE semantic repeat-guard (call_registry.js): identical calls are answered with the
// previous result instead of running again, a real user send or a permission change clears it, and the
// window is what expires it — all without a page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console, setTimeout, clearTimeout });
for (const file of ['constants.js', 'utils.js', 'call_registry.js']) {
  vm.runInContext(readFileSync(new URL(`../content_scripts/${file}`, import.meta.url), 'utf8'), context);
}
const { WMB } = context;

const args = { command: 'df -h /' };
const registry = new WMB.CallRegistry({ windowMs: 60_000, max: 1 });
const key = registry.key('terminal', 'run_command', args);

// 1) A fresh call has no history: it runs.
assert.equal(registry.repeats(key), 0, 'a fresh call has no repeats');
assert.equal(registry.lastResult(key), null);

// 2) The first run is recorded; the SECOND identical call is over the max and replays the result.
registry.record(key, { status: 'ok', text: 'Filesystem usage…' });
assert.equal(registry.repeats(key), 1, 'one recorded run inside the window');
assert.deepEqual(registry.lastResult(key), { status: 'ok', text: 'Filesystem usage…' });

// 3) The replay itself counts: the count and the window move with it.
registry.bump(key);
assert.equal(registry.repeats(key), 2, 'the replay was counted too');

// 4) A CHANGED call is a different key: it runs fresh.
assert.equal(registry.repeats(registry.key('terminal', 'run_command', { command: 'df -h /var' })), 0, 'a changed argument is a different call');
assert.equal(registry.repeats(registry.key('terminal', 'terminal_info', args)), 0, 'a different tool is a different call');

// 5) Outside the window the same call runs fresh again.
const short = new WMB.CallRegistry({ windowMs: 30, max: 1 });
const shortKey = short.key('terminal', 'run_command', args);
short.record(shortKey, { status: 'ok' });
await new Promise((resolve) => setTimeout(resolve, 45));
assert.equal(short.repeats(shortKey), 0, 'the window expires: the same call may run again');

// 6) A refusal is cached too — the exact «not permitted» answer, not a new dialog on every retry.
registry.record(registry.key('terminal', 'run_command', { command: 'sudo rm -rf /' }), { status: 'rejected' });
assert.equal(registry.lastResult(registry.key('terminal', 'run_command', { command: 'sudo rm -rf /' })).status, 'rejected');

// 7) A real user send (or a permission change) clears everything.
registry.clear();
assert.equal(registry.repeats(key), 0, 'after a clear, the same call runs fresh');
assert.equal(registry.size, 0, 'and nothing is remembered');

// 8) Memory is bounded: at most 50 calls are remembered, oldest dropped first.
const many = new WMB.CallRegistry({ windowMs: 60_000, max: 1 });
const firstKey = many.key('terminal', 'run_command', { n: 0 });
for (let i = 0; i < 60; i += 1) many.record(many.key('terminal', 'run_command', { n: i }), { status: 'ok', text: `r${i}` });
assert.equal(many.size, 50, 'the cache never grows past its cap');
assert.equal(many.repeats(firstKey), 0, 'the oldest entry was dropped');
assert.equal(many.repeats(many.key('terminal', 'run_command', { n: 59 })), 1, 'the newest entry is kept');

// 9) An expired entry is really dropped (not just ignored), so the map shrinks with time.
const timed = new WMB.CallRegistry({ windowMs: 30, max: 1 });
const timedKey = timed.key('terminal', 'run_command', { n: 'x' });
timed.record(timedKey, { status: 'ok' });
assert.equal(timed.size, 1);
await new Promise((resolve) => setTimeout(resolve, 45));
assert.equal(timed.repeats(timedKey), 0, 'an expired entry answers fresh');
assert.equal(timed.size, 0, 'and it is removed from the map');

// 10) A huge result is not kept in memory: the replay gets the status and a short honest notice.
const huge = new WMB.CallRegistry({ windowMs: 60_000, max: 1 });
const hugeKey = huge.key('terminal', 'run_command', { n: 'huge' });
huge.record(hugeKey, { status: 'ok', text: 'x'.repeat(300_000) });
const kept = huge.lastResult(hugeKey);
assert.equal(kept.status, 'ok', 'the status survives');
assert.ok(kept.text.length < 500, 'the payload itself is not kept');
assert.match(kept.text, /not kept in memory/, 'and the notice says so');
// A normal result is kept as it was.
const small = { status: 'error', text: 'a small failure' };
huge.record(huge.key('terminal', 'run_command', { n: 'small' }), small);
assert.deepEqual(huge.lastResult(huge.key('terminal', 'run_command', { n: 'small' })), small);

console.log('✔ test_registry: all checks passed');
