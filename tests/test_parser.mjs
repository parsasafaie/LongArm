// Tests for the tolerant parser (mcp_parser.js): repaired JSON, flags and format warnings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['constants.js', 'utils.js', 'mcp_parser.js']) vm.runInContext(readFileSync(new URL(`../content_scripts/${f}`, import.meta.url), 'utf8'), context);
const { WMB } = context;

WMB.tools = [
  { server: 'windows_management', serverLabel: 'windows-management', name: 'execute_powershell', inputSchema: { type: 'object', properties: { script: { type: 'string' }, require_admin: { type: 'boolean' } } } },
  { server: 'v380_camara', serverLabel: 'v380-camara', name: 'ptz_move', inputSchema: { type: 'object', properties: { direction: { type: 'string' }, duration: { type: 'number' } } } },
];
const one = (text) => { const calls = WMB.extractMcpCalls(text); assert.equal(calls.length, 1, `expected 1 call in: ${text}`); return calls[0]; };

// 1) Valid JSON: the strict layer keeps working the same
assert.equal(one('{"mcp_call":{"server":"v380_camara","name":"ptz_move","arguments":{"direction":"LEFT","duration":5.0}}}').arguments.duration, 5);

// 2) Windows path with stray backslashes (the most common failure)
let call = one(String.raw`{"mcp_call":{"server":"windows_management","name":"execute_powershell","arguments":{"script":"Get-Content -LiteralPath 'C:\Users\user\_ptz.out' -Raw"}}}`);
assert.equal(call.arguments.script, String.raw`Get-Content -LiteralPath 'C:\Users\user\_ptz.out' -Raw`);

// 2b) A drive path whose `\n` would be a VALID JSON escape: the backslash pre-pass runs before the strict
// layer, so the command arrives exactly as written instead of decoded into a line break + tab.
call = one(String.raw`{"mcp_call":{"server":"windows_management","name":"execute_powershell","arguments":{"script":"type C:\new\text.txt"}}}`);
assert.equal(call.arguments.script, String.raw`type C:\new\text.txt`);
// An already-valid drive path is left exactly as it was.
call = one(String.raw`{"mcp_call":{"server":"windows_management","name":"execute_powershell","arguments":{"script":"dir C:\\new\\test.txt"}}}`);
assert.equal(call.arguments.script, String.raw`dir C:\new\test.txt`);

// 2c) A drive path and a valid escaped quote/newline in the SAME string: the path keeps its separator and
// the escapes keep their meaning (the old pre-pass doubled every backslash, breaking `\"` and `\n`).
call = one(String.raw`{"mcp_call":{"server":"windows_management","name":"execute_powershell","arguments":{"script":"cd C:\Users && echo \"hello\""}}}`);
assert.equal(call.arguments.script, String.raw`cd C:\Users && echo "hello"`);
call = one(String.raw`{"mcp_call":{"server":"windows_management","name":"execute_powershell","arguments":{"script":"cd C:\Users && echo a\nb"}}}`);
assert.equal(call.arguments.script, 'cd C:\\Users && echo a\nb');

// 3) Real line break inside a text
call = one('{"mcp_call":{"server":"windows_management","name":"execute_powershell","arguments":{"script":"$a=1\n$b=2"}}}');
assert.equal(call.arguments.script, '$a=1\n$b=2');

// 4) Unescaped inner quotes
call = one('{"mcp_call":{"server":"windows_management","name":"execute_powershell","arguments":{"script":"Write-Output "hello" ; ok"}}}');
assert.equal(call.arguments.script, 'Write-Output "hello" ; ok');

// 5) Trailing comma + typographic quotes
call = one('{\u201cmcp_call\u201d:{\u201cserver\u201d:\u201cv380_camara\u201d,\u201cname\u201d:\u201cptz_move\u201d,\u201carguments\u201d:{\u201cdirection\u201d:\u201cLEFT\u201d,}}}');
assert.equal(call.arguments.direction, 'LEFT');

// 6) Flags: unrepairable JSON, but server/name/arguments are read separately with the schema
call = one('```json\n{"mcp_call":{"server":"windows-management","name":"execute_powershell","arguments":{"script":"echo "a", "b" ok","require_admin":false}}}\n```');
assert.equal(call.server, 'windows_management');
assert.equal(call.arguments.script, 'echo "a", "b" ok');
assert.equal(call.arguments.require_admin, false);

// 7) No false positive: server or tool that do not exist
assert.equal(WMB.extractMcpCalls('{"mcp_call": broken {"server":"other","name":"none","arguments":{x}}}').length, 0);

// 8) Cut-off message: it is not a call, but there is intent -> the AI is warned
const cut = '{"mcp_call":{"server":"v380_camara","name":"ptz_move","arguments":{"direction":"LE';
assert.equal(WMB.extractMcpCalls(cut).length, 0);
assert.equal(WMB.looksMalformed(cut), true);
assert.match(WMB.diagnoseMcp(cut), /incomplete/);

// 9) Specific diagnostics
const bad = String.raw`{"mcp_call":{"server":"x","name":"y","arguments":{"p":"C:\Users\a", }}}`;
assert.match(WMB.diagnoseMcp(bad), /escape/);
assert.match(WMB.formatCallError(bad), /status="format_error"/);

// 10) Normal text without intent: no warning
assert.equal(WMB.looksMalformed('Hello, I do not need any tools.'), false);
assert.equal(WMB.looksMalformed('Use the mcp_call format whenever you want.'), false);

// 10b) Text that only QUOTES the format (a placeholder in the name) is not intent: no warning.
assert.equal(WMB.looksMalformed('To call a tool, send {"mcp_call":{"server":"<server>","name":"<tool>","arguments":{}}}.'), false);
assert.equal(WMB.looksMalformed('Format: {"mcp_call":{"name":"tool_name"}} — replace tool_name with a real tool.'), false);
// …while a REAL attempt with a broken block (an identifier name) still warns.
assert.equal(WMB.looksMalformed('{"mcp_call":{"name":"ptz_move","arguments":{"direction":"LEFT"'), true);

// 11) Mixed batch: one valid block must not swallow its sibling. A repairable sibling runs; a cut-off one
// produces a format warning instead of disappearing silently.
const okBlock = '{"mcp_call":{"server":"v380_camara","name":"ptz_move","arguments":{"direction":"LEFT"}}}';
const repairable = '{"mcp_call":{"server":"v380_camara","name":"ptz_move","arguments":{"direction":"RIGHT" "duration":2}}}';
const mixed = `${okBlock}\n${repairable}`;
assert.equal(WMB.extractMcpCalls(mixed).length, 2, 'a repairable sibling of a valid call is read and kept');
assert.equal(WMB.looksMalformed(mixed), false, 'nothing is left unreadable in that batch');

const cutSibling = '{"mcp_call":{"server":"v380_camara","name":"ptz_move","arguments":{"direction":"UP"';
const mixedCut = `${okBlock}\n${cutSibling}`;
assert.equal(WMB.extractMcpCalls(mixedCut).length, 1, 'the valid call is still extracted');
assert.equal(WMB.looksMalformed(mixedCut), true, 'the cut-off sibling counts as malformed intent');
assert.equal(WMB.malformedCallBlocks(mixedCut).length, 1, 'exactly the broken block is reported');

// 12) A format_error must not tell the AI that NOTHING in the message ran: readable siblings may have.
const errorText = WMB.formatCallError(cut);
assert.match(errorText, /This block was not executed/, 'the error is scoped to the block');
assert.match(errorText, /may already have run/i, 'and warns that readable siblings may have run');
assert.ok(!/^Nothing was run:/m.test(errorText), 'the old whole-message claim is gone');

console.log('ok test_parser: all checks passed');