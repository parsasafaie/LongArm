// Tests for the MCP call parser and the result formatter (no browser).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['constants.js', 'utils.js']) vm.runInContext(readFileSync(new URL(`../content_scripts/${f}`, import.meta.url), 'utf8'), context);
const { WMB } = context;

// 1) Code block with text around it
let calls = WMB.scanCallsText('Let me take a look.\n```json\n{\n "mcp_call": {"server":"demo","name":"read","arguments":{"path":"a.txt"}}\n}\n```');
assert.equal(calls.length, 1);
assert.deepEqual({ ...calls[0], arguments: { ...calls[0].arguments } }, { server: 'demo', name: 'read', arguments: { path: 'a.txt' } });

// 2) Incomplete JSON (streaming) → not detected
assert.equal(WMB.scanCallsText('{"mcp_call": {"server":"a","name":"b","argum').length, 0);

// 3) Braces and quotes inside strings
calls = WMB.scanCallsText('{"mcp_call":{"server":"s","name":"t","arguments":{"code":"if (x) { return \\"}\\"; }"}}}');
assert.equal(calls.length, 1);
assert.equal(calls[0].arguments.code, 'if (x) { return "}"; }');

// 4) Non-standard spaces (NBSP) after rendering
assert.equal(WMB.scanCallsText('{\u00a0"mcp_call":\u00a0{"server":"s",\u00a0"name":"t"}}').length, 1);

// 5) No call
assert.equal(WMB.scanCallsText('Hello, the mcp_call format is used for tools.').length, 0);

// 6) Two calls in the same message
assert.equal(WMB.scanCallsText('{"mcp_call":{"name":"a"}} and then {"mcp_call":{"name":"b"}}').length, 2);

// 7) Hash stable and different
assert.equal(WMB.hash('x'), WMB.hash('x'));
assert.notEqual(WMB.hash('x'), WMB.hash('y'));

// 8) Typographic quotes (some renderers use them) and arguments serialized as text
assert.equal(WMB.scanCallsText('{“mcp_call”:{“server”:“s”,“name”:“t”,“arguments”:{“a”:1}}}').length, 1);
assert.deepEqual({ ...WMB.scanCallsText('{"mcp_call":{"name":"t","arguments":"{\\"a\\":1}"}}')[0].arguments }, { a: 1 });

// 9) Images: NEVER omitted, they travel as an attached file
const shot = { content: [{ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }] };
let plan = WMB.planResult(shot, { server: 'demo_mcp', name: 'take_screenshot', status: 'ok' });
assert.equal(plan.files.length, 1);
assert.equal(plan.files[0].mime, 'image/jpeg');
assert.equal(plan.files[0].b64, 'QUJD');
let message = plan.build(true);
assert.ok(!message.includes('omitted'), 'must not say "image omitted"');
assert.match(message, /^\[MCP_RESULT server="demo_mcp" tool="take_screenshot" status="ok"\]\n\[image attached to this message: demo_mcp_take_screenshot_1\.jpg \(image\/jpeg, 1 KB\)\]\n\[\/MCP_RESULT\]$/);
assert.match(plan.build(false), /image NOT attached/); // if the chat does not support attachments, it warns and downloads

// 10) Text + image + resource + structuredContent: everything is preserved
plan = WMB.planResult({
  content: [
    { type: 'text', text: 'hello' },
    { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    { type: 'audio', data: 'QUJD', mimeType: 'audio/wav' },
    { type: 'resource', resource: { uri: 'file:///a.txt', text: 'content' } },
    { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'QUJD', mimeType: 'application/pdf' } },
    { type: 'resource_link', uri: 'https://x.test', name: 'X' },
    { type: 'weird', value: 1 },
  ],
  structuredContent: { total: 3 },
}, { server: 's', name: 't', status: 'ok' });
message = plan.build(true);
assert.equal(plan.files.length, 3);
for (const piece of ['hello', '.png', '.wav', '[resource file:///a.txt]\ncontent', 'b.bin', '.pdf', '[link: https://x.test · X]', '{"kind":"weird"', '"total": 3']) {
  if (piece === '{"kind":"weird"') assert.ok(message.includes('"type":"weird"'));
  else assert.ok(message.includes(piece), `missing: ${piece}`);
}
// structuredContent duplicated in the text is not repeated
plan = WMB.planResult({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } }, { server: 's', name: 't', status: 'ok' });
assert.equal(plan.build(true).split('"a"').length - 1, 1);

// 11) Long texts: NOT clipped; they are attached in full as a file (or go entirely inline if attaching fails)
const long = 'x'.repeat(5000);
plan = WMB.planResult({ content: [{ type: 'text', text: long }] }, { server: 's', name: 't', status: 'ok', maxChars: 1000 });
assert.equal(plan.files.length, 1);
assert.equal(plan.files[0].text, long);
assert.ok(plan.build(true).length < 2200);
assert.match(plan.build(true), /FULL content in the attached file s_t_full\.txt/);
assert.ok(plan.build(false).includes(long), 'without an attachment, the full text goes inline');
assert.equal(WMB.planResult({ content: [{ type: 'text', text: 'short' }] }, { server: 's', name: 't', status: 'ok' }).files.length, 0);

// 12) UUID & RequestLifecycle State Machine
const uuid1 = WMB.generateUuid();
const uuid2 = WMB.generateUuid();
assert.equal(typeof uuid1, 'string');
assert.equal(uuid1.length, 36);
assert.notEqual(uuid1, uuid2);

const lifecycle = new WMB.RequestLifecycle({ server: 'terminal', name: 'run', arguments: { command: 'dir' } });
assert.equal(lifecycle.state, 'queued');
assert.ok(lifecycle.id);
lifecycle.start();
assert.equal(lifecycle.state, 'running');
assert.ok(lifecycle.startedAt);
lifecycle.finish({ state: 'completed', stdout: 'output', stderr: '', exitCode: 0, durationMs: 42 });
assert.equal(lifecycle.state, 'completed');
assert.equal(lifecycle.durationMs, 42);

const payload = lifecycle.toJSON();
assert.equal(payload.request_id, lifecycle.id);
assert.equal(payload.status, 'completed');
assert.equal(payload.result.stdout, 'output');
assert.equal(payload.result.stderr, '');
assert.equal(payload.result.exit_code, 0);
assert.equal(payload.cached, false);

console.log('✔ test_utils: all checks passed');
