// Tests for the MCP connection state machine (ws_client.js): the handshake, request timeouts,
// server-initiated pings, and the reconnect behaviour — with a fake WebSocket on real timers.
import assert from 'node:assert/strict';

// The module reads the extension version through chrome.*; a stand-in is enough here.
globalThis.chrome = { runtime: { getManifest: () => ({ version: '0.2.0' }) } };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ───────────────────────── A fake MCP server on a WebSocket ─────────────────────────
let sockets = [];
let answer = true; // false = the server never answers (for the timeout case)
let loopCursor = false; // true = tools/list always repeats nextCursor

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }

  send(raw) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    if (!answer || msg.id === undefined) return;
    const reply = (result) => setTimeout(() => {
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) });
    }, 0);
    if (msg.method === 'initialize') reply({ serverInfo: { name: 'fake', version: '1' } });
    else if (msg.method === 'tools/list') {
      if (loopCursor) reply({ tools: [{ name: 'loop' }], nextCursor: 'forever' });
      else reply(msg.params?.cursor ? { tools: [{ name: 'second' }] } : { tools: [{ name: 'first' }], nextCursor: 'page2' });
    } else if (msg.method === 'tools/call') reply({ content: [{ type: 'text', text: 'done' }] });
    else reply({});
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.(), 0);
  }

  /** The server drops the connection (not the client): this is what the reconnect logic answers to. */
  serverClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}
globalThis.WebSocket = FakeWebSocket;

const { McpConnection } = await import('../background/ws_client.js');

// ───────────────────────── 1. Handshake: initialize → tools/list (both pages) → connected ─────────────────────────

const events = [];
const conn = new McpConnection({ id: 'srv', name: 'terminal', url: 'ws://127.0.0.1:9' }, (event) => events.push(event));
conn.connect();
assert.equal(conn.status, 'connecting');
assert.equal(await conn.whenReady(2000), true, 'the connection becomes ready after the handshake');
assert.equal(conn.serverInfo?.name, 'fake', 'serverInfo is kept');
assert.deepEqual(conn.tools.map((t) => t.name), ['first', 'second'], 'tools/list follows nextCursor to the last page');
assert.deepEqual(
  events.filter((e) => e.kind === 'status').map((e) => `${e.prev}>${e.next}`),
  ['disconnected>connecting', 'connecting>connected'],
  'status transitions are reported in order',
);
assert.ok(events.some((e) => e.kind === 'tools'), 'a tools event is reported after the re-list');

// ───────────────────────── 2. A request with no answer times out ─────────────────────────

answer = false;
await assert.rejects(() => conn.request('slow/method', {}, 80), /Timed out on «slow\/method»/, 'a silent request rejects');
let timedOutToolWireId = null;
await assert.rejects(async () => {
  const pending = conn.callTool('run', { command: 'x' }, 80);
  timedOutToolWireId = sockets.at(-1).sent.filter((m) => m.method === 'tools/call').at(-1)?.id ?? null;
  await pending;
}, /may still be running/, 'a timed-out TOOL warns that it may have partially run');
await sleep(10);
assert.ok(
  sockets.at(-1).sent.some((m) => m.method === 'notifications/cancelled'
    && m.params?.requestId === timedOutToolWireId
    && /timed out/i.test(m.params?.reason ?? '')),
  'a timed-out tool call is cancelled on the wire (the bridge stops the child; nobody is waiting for it)',
);
answer = true;

// ───────────────────────── 3. Requests from the server side: ping answered, others refused ─────────────────────────

const socket = sockets[0];
socket.sent.length = 0;
socket.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: 901, method: 'ping' }) });
socket.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: 902, method: 'resources/list' }) });
assert.deepEqual(socket.sent.find((m) => m.id === 901), { jsonrpc: '2.0', id: 901, result: {} }, 'ping is answered locally');
assert.equal(socket.sent.find((m) => m.id === 902)?.error?.code, -32601, 'an unknown server request gets -32601');

// ───────────────────────── 4. callTool sends tools/call and returns its result ─────────────────────────

const result = await conn.callTool('run', { command: 'x' }, 1000, 'req-4');
assert.equal(result.content[0].text, 'done');
assert.equal(sockets.at(-1).sent.find((m) => m.method === 'tools/call' && m.params?.arguments?.command === 'x').params._meta['longarm/request_id'], 'req-4', 'the request id travels in _meta');

// Cancellation: the pending promise rejects at once and the server gets notifications/cancelled.
answer = false;
const slow = conn.callTool('run', { command: 'slow' }, 5000, 'req-cancel');
await sleep(20);
const slowWireId = sockets.at(-1).sent.filter((m) => m.method === 'tools/call').at(-1).id;
assert.equal(conn.cancel('req-cancel'), true, 'the in-flight call is found by its request id');
await assert.rejects(() => slow, /Cancelled/, 'the caller stops waiting immediately');
assert.deepEqual(
  sockets.at(-1).sent.find((m) => m.method === 'notifications/cancelled' && m.params?.requestId === slowWireId).params,
  { requestId: slowWireId, reason: 'cancelled by the user or the queue budget' },
  'the server is told which JSON-RPC request to cancel',
);
assert.equal(conn.cancel('req-cancel'), false, 'cancelling twice does nothing');
answer = true;

// ───────────────────────── 5. A server-side close reconnects; a client close does not ─────────────────────────

const before = sockets.length;
sockets[0].serverClose();
assert.equal(conn.status, 'disconnected', 'the drop is reported');
await sleep(1700); // the first backoff step is ~1.0–1.5 s
assert.equal(sockets.length, before + 1, 'a new socket is opened');
assert.equal(await conn.whenReady(2000), true, 'and the handshake completes again');

const afterReconnect = sockets.length;
conn.close();
assert.equal(conn.status, 'disconnected');
await sleep(1700);
assert.equal(sockets.length, afterReconnect, 'a user close never reconnects');

// ───────────────────────── 6. whenReady before any connection resolves false ─────────────────────────

const idle = new McpConnection({ id: 'idle', name: 'x', url: 'ws://127.0.0.1:9' });
assert.equal(await idle.whenReady(50), false, 'it never became ready');
assert.equal(idle.status, 'disconnected');

// ───────────────────────── 7. A server that repeats nextCursor cannot hang the handshake ─────────────────────────

loopCursor = true;
const looping = new McpConnection({ id: 'loop', name: 'loop', url: 'ws://127.0.0.1:9' });
looping.connect();
assert.equal(await looping.whenReady(3000), true, 'the handshake completes despite the endless cursor');
assert.ok(looping.tools.length <= 50, `tools/list is capped (got ${looping.tools.length} pages)`);
looping.close();
loopCursor = false;

console.log('✔ test_ws_client: all checks passed');
process.exit(0); // the keepalive interval of the connections keeps the process alive
