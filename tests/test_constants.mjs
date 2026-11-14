// Tests the generated constants: content scripts get exactly what shared/constants.js says.
//
// The extension has two module worlds — ES modules (background, popup, welcome) that import shared/constants.js,
// and classic content scripts that cannot. `scripts/build_constants.mjs` writes the second world's copy;
// this test fails when that file is stale, so a status, a permission label, a settings default or a timeout can
// only ever change in one place.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const context = vm.createContext({ console, setTimeout, clearTimeout });
vm.runInContext(readFileSync(new URL('../content_scripts/constants.js', import.meta.url), 'utf8'), context);
const { WMB } = context;

const shared = await import('../shared/constants.js');

/** Values made inside the VM live in another realm; a plain copy lets both sides compare strictly. */
const plain = (value) => JSON.parse(JSON.stringify(value));

// ───────────────────────── The generated file matches the source ─────────────────────────

assert.ok(WMB.defaults, 'content_scripts/constants.js defines WMB.defaults');
assert.deepEqual(plain(WMB.defaults.settings), shared.DEFAULT_SETTINGS, 'the settings defaults are shared/constants.js, verbatim');
assert.deepEqual(plain(WMB.defaults.permissions), shared.PERMISSIONS, 'the three permission states');
assert.deepEqual(plain(WMB.defaults.permissionLabels), shared.PERMISSION_LABELS, 'their full wording');
assert.deepEqual(plain(WMB.defaults.statuses), shared.RESULT_STATUSES, 'the result statuses');
assert.deepEqual(plain(WMB.defaults.timeouts), shared.CONTENT_TIMEOUTS, 'the controller timeouts');
assert.deepEqual(plain(WMB.defaults.repeat), shared.REPEAT_CALLS, 'the repeat window');

// The two waits that must keep their order: the page lets the background's own deadline pass first, so a timeout
// is reported by the side that owns the request.
assert.ok(WMB.defaults.timeouts.tool > shared.CALL_TIMEOUT_MS, 'the page waits longer than the service worker');

// The error notice the lenient parser writes spells its status out; it must be one of the shared statuses.
const parser = readFileSync(new URL('../content_scripts/mcp_parser.js', import.meta.url), 'utf8');
const notice = /status="([a-z_]+)"/.exec(parser);
assert.ok(notice, 'the format_error notice exists');
assert.ok(WMB.defaults.statuses.includes(notice[1]), `«${notice[1]}» is one of the shared statuses`);

// ───────────────────────── The file on disk is not stale ─────────────────────────

const before = readFileSync(new URL('../content_scripts/constants.js', import.meta.url), 'utf8');
execFileSync(process.execPath, ['scripts/build_constants.mjs'], { cwd: new URL('..', import.meta.url), stdio: 'ignore' });
const after = readFileSync(new URL('../content_scripts/constants.js', import.meta.url), 'utf8');
assert.equal(after, before, 'content_scripts/constants.js matches (run: npm run constants)');

// ───────────────────────── The content scripts actually read it ─────────────────────────

const utils = readFileSync(new URL('../content_scripts/utils.js', import.meta.url), 'utf8');
assert.ok(!/maxChars = \d/.test(utils), 'no hardcoded result cap is left in utils.js');
assert.ok(utils.includes('WMB.defaults.settings.maxResultChars'), 'utils.js takes the result cap from the constants');
const core = readFileSync(new URL('../content_scripts/core_bridge.js', import.meta.url), 'utf8');
assert.ok(!/(TOOL_TIMEOUT_MS|DELIVER_TIMEOUT_MS|HEARTBEAT_MS|REPEAT_WINDOW_MS|MAX_REPEATS) = \d/.test(core), 'no hardcoded timeout or window is left in core_bridge.js');
assert.ok(core.includes('WMB.defaults.timeouts') && core.includes('WMB.defaults.repeat'), 'core_bridge.js takes both from the constants');
assert.ok(!/maxResultChars: 12000/.test(core), 'no hardcoded settings default is left in core_bridge.js');

console.log('✔ test_constants: all checks passed');
