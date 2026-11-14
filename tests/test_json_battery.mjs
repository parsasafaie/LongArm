// "Dirty" JSON battery: what AIs actually write. None of it may slip through or run incorrectly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['constants.js', 'utils.js', 'mcp_parser.js']) vm.runInContext(readFileSync(new URL(`../content_scripts/${f}`, import.meta.url), 'utf8'), context);
const { WMB } = context;
WMB.tools = [
  { server: 'win', serverLabel: 'windows-management', name: 'run', inputSchema: { type: 'object', properties: { script: { type: 'string' }, admin: { type: 'boolean' }, n: { type: 'number' }, list: { type: 'array' } } } },
  { server: 'cam', serverLabel: 'camera', name: 'move', inputSchema: { type: 'object', properties: { dir: { type: 'string' }, secs: { type: 'number' } } } },
];

const S = String.raw;
const cases = [
  ['valid inside a block', '```json\n{"mcp_call":{"server":"cam","name":"move","arguments":{"dir":"UP","secs":2}}}\n```', { name: 'move', arguments: { dir: 'UP', secs: 2 } }],
  ['with prose around it', 'I am going to move.\n{"mcp_call":{"server":"cam","name":"move","arguments":{"dir":"UP"}}}\nDone }', { name: 'move', arguments: { dir: 'UP' } }],
  ['Python-style single quotes', "{'mcp_call': {'server': 'cam', 'name': 'move', 'arguments': {'dir': 'UP', 'secs': 3}}}", { name: 'move', arguments: { dir: 'UP', secs: 3 } }],
  ['True/False/None', "{'mcp_call': {'server': 'win', 'name': 'run', 'arguments': {'script': 'ls', 'admin': False}}}", { name: 'run', arguments: { script: 'ls', admin: false } }],
  ['unquoted keys', '{mcp_call:{server:"cam",name:"move",arguments:{dir:"UP",secs:1}}}', { name: 'move', arguments: { dir: 'UP', secs: 1 } }],
  ['HTML entities', '{&quot;mcp_call&quot;:{&quot;server&quot;:&quot;cam&quot;,&quot;name&quot;:&quot;move&quot;,&quot;arguments&quot;:{&quot;dir&quot;:&quot;UP&quot;}}}', { name: 'move', arguments: { dir: 'UP' } }],
  ['arguments as JSON text', '{"mcp_call":{"server":"cam","name":"move","arguments":"{\\"dir\\":\\"UP\\"}"}}', { name: 'move', arguments: { dir: 'UP' } }],
  ['path with stray backslashes', S`{"mcp_call":{"server":"win","name":"run","arguments":{"script":"dir C:\Users\user\Desktop"}}}`, { name: 'run', arguments: { script: S`dir C:\Users\user\Desktop` } }],
  ['drive path whose \\n is NOT a newline', S`{"mcp_call":{"server":"win","name":"run","arguments":{"script":"type C:\new\text.txt"}}}`, { name: 'run', arguments: { script: S`type C:\new\text.txt` } }],
  ['already-escaped drive path stays as written', S`{"mcp_call":{"server":"win","name":"run","arguments":{"script":"dir C:\\new\\test.txt"}}}`, { name: 'run', arguments: { script: S`dir C:\new\test.txt` } }],
  ['real newline inside the text', '{"mcp_call":{"server":"win","name":"run","arguments":{"script":"a=1\nb=2"}}}', { name: 'run', arguments: { script: 'a=1\nb=2' } }],
  ['pretty multiline JSON', '{\n  "mcp_call": {\n    "server": "cam",\n    "name": "move",\n    "arguments": {\n      "dir": "UP"\n    }\n  }\n}', { name: 'move', arguments: { dir: 'UP' } }],
  ['escaped unicode', '{"mcp_call":{"server":"win","name":"run","arguments":{"script":"echo \\u00fc"}}}', { name: 'run', arguments: { script: 'echo \u00fc' } }],
  ['braces inside the text', '{"mcp_call":{"server":"win","name":"run","arguments":{"script":"if($a){ \\"x}\\" }"}}}', { name: 'run', arguments: { script: 'if($a){ "x}" }' } }],
  ['nested with arrays', '{"mcp_call":{"server":"win","name":"run","arguments":{"list":[1,2,{"a":"b"}],"script":"x"}}}', { name: 'run', arguments: { list: [1, 2, { a: 'b' }], script: 'x' } }],
  ['zero-width space inside the key', '{"mcp\u200b_call":{"server":"cam","name":"move","arguments":{"dir":"UP"}}}', { name: 'move', arguments: { dir: 'UP' } }],
  ['nbsp and tabs', '{\u00a0"mcp_call":\t{"server":"cam",\u00a0"name":"move","arguments":{"dir":"UP"}}}', { name: 'move', arguments: { dir: 'UP' } }],
  ['inside an array', '[{"mcp_call":{"server":"cam","name":"move","arguments":{"dir":"UP"}}}]', { name: 'move', arguments: { dir: 'UP' } }],
  ['// comment inside', '{"mcp_call":{"server":"cam", // camera\n"name":"move","arguments":{"dir":"UP"}}}', { name: 'move', arguments: { dir: 'UP' } }],
  ['trailing comma in arguments', '{"mcp_call":{"server":"cam","name":"move","arguments":{"dir":"UP",},}}', { name: 'move', arguments: { dir: 'UP' } }],
  ['missing closing braces but the text continues', '{"mcp_call":{"server":"cam","name":"move","arguments":{"dir":"UP"}}', null],
  ['number as text in schema number', '{"mcp_call":{"server":"cam","name":"move","arguments":{"dir":"UP","secs":"4"}}}', { name: 'move', arguments: { dir: 'UP', secs: '4' } }],
];

let failed = 0;
for (const [label, text, expected] of cases) {
  const calls = WMB.extractMcpCalls(text);
  if (expected === null) {
    // Nothing odd must be executed: either no call at all, or the AI gets a warning (looksMalformed)
    const okNone = calls.length === 0 ? WMB.looksMalformed(text) : calls.length === 1;
    if (!okNone) { failed += 1; console.error(`FAIL [${label}] expected none/safe, got`, JSON.stringify(calls)); }
    continue;
  }
  try {
    assert.equal(calls.length, 1, `calls: ${calls.length}`);
    assert.equal(calls[0].name, expected.name);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].arguments)), expected.arguments);
  } catch (e) { failed += 1; console.error(`FAIL [${label}]: ${e.message.split('\n')[0]}`); }
}
if (failed) { console.error(`${failed}/${cases.length} cases failed`); process.exit(1); }
console.log(`ok test_json_battery: ${cases.length} cases`);