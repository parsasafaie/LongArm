/**
 * ws_client.js — MCP client over WebSocket with automatic reconnection.
 *
 * Each `McpConnection` instance manages ONE local MCP server:
 *   - Connects, does the `initialize` handshake and fetches `tools/list`.
 *   - Reconnects with exponential backoff if the server goes down.
 *   - Keeps a periodic ping so the MV3 Service Worker does not fall asleep
 *     while there are open connections.
 */
import { PROTOCOL_VERSION } from '../shared/constants.js';

const KEEPALIVE_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export class McpConnection {
  #ws = null;
  #pending = new Map();
  #requestIds = new Map(); // end-to-end request id → JSON-RPC id on the wire
  #nextId = 1;
  #closedByUser = false;
  #attempt = 0;
  #reconnectTimer = null;
  #keepaliveTimer = null;
  #ready = null;
  #resolveReady = null;

  /**
   * @param {{id:string,name:string,url:string}} server
   * @param {(evt:{kind:'status'|'tools',prev?:string,next?:string}) => void} onChange
   */
  constructor(server, onChange = () => {}) {
    this.server = server;
    this.onChange = onChange;
    this.status = 'disconnected'; // connecting | connected | disconnected | error
    this.tools = [];
    this.serverInfo = null;
    this.lastError = null;
    this.#resetReady();
  }

  // ───────────────────────── Public API ─────────────────────────

  connect() {
    this.#closedByUser = false;
    clearTimeout(this.#reconnectTimer);
    const state = this.#ws?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    this.#setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.server.url);
    } catch (err) {
      this.lastError = err.message;
      this.#setStatus('error');
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.onopen = () => {
      this.#handshake().catch((err) => {
        this.lastError = err.message;
        this.#setStatus('error');
        ws.close();
      });
    };
    ws.onmessage = (event) => this.#onMessage(event.data);
    ws.onerror = () => {
      this.lastError = this.#attempt >= 3
        ? 'Could not connect to the MCP server. Repeated handshake failures: if your browser upgrades ws:// to wss:// (HTTPS-First or a VPN), the bridge does not speak TLS — check the browser settings or server/bridge.log.'
        : 'Could not connect to the MCP server.';
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#teardown();
      if (!this.#closedByUser) {
        this.#setStatus('disconnected');
        this.#scheduleReconnect();
      }
    };
  }

  close() {
    this.#closedByUser = true;
    clearTimeout(this.#reconnectTimer);
    const ws = this.#ws;
    this.#ws = null;
    try { ws?.close(); } catch { /* noop */ }
    this.#teardown();
    this.#setStatus('disconnected');
  }

  /** Waits for the connection to be ready (handshake + tools/list). */
  whenReady(timeoutMs = 4000) {
    if (this.status === 'connected') return Promise.resolve(true);
    return Promise.race([
      this.#ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  /**
   * Sends a JSON-RPC request and waits for the response.
   * `requestId` is the controller's end-to-end id: it travels in the MCP `_meta` so a server (and the logs)
   * can correlate the call even though JSON-RPC needs its own numeric id on the wire.
   */
  request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS, requestId = null) {
    return new Promise((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error('MCP server disconnected.'));
        return;
      }
      const id = this.#nextId++;
      if (requestId) this.#requestIds.set(requestId, id);
      const forget = () => {
        if (requestId && this.#requestIds.get(requestId) === id) this.#requestIds.delete(requestId);
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        forget();
        // A tool the page stopped waiting for must be stopped on the server too: the bridge turns
        // `notifications/cancelled` into a hard stop of the tool child. Otherwise the request id is gone from
        // #requestIds and a later CANCEL_TOOL cannot find it: the command would keep running with nobody left
        // to read its answer.
        if (method === 'tools/call' && this.#ws?.readyState === WebSocket.OPEN) {
          try {
            this.#ws.send(JSON.stringify({
              jsonrpc: '2.0', method: 'notifications/cancelled',
              params: { requestId: id, reason: 'timed out waiting for the tool' },
            }));
          } catch { /* the socket is already gone: the close/reconnect path handles it */ }
        }
        const hint = method === 'tools/call'
          ? ' The tool may still be running or may have partially applied; do not resend the same call until you check its effect.'
          : '';
        reject(new Error(`Timed out on «${method}».${hint}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, requestId, forget });
      const wireParams = requestId ? { ...params, _meta: { ...(params._meta ?? {}), 'longarm/request_id': requestId } } : params;
      this.#ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: wireParams }));
    });
  }

  notify(method, params) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }));
    }
  }

  callTool(name, args, timeoutMs, requestId = null) {
    return this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs, requestId);
  }

  /**
   * Cancels an in-flight call by its end-to-end id: the pending promise rejects at once and the server gets
   * `notifications/cancelled`. The bridge turns that into a hard stop of the tool child (the MCP protocol's
   * cancellation is advisory; a terminal command may ignore it).
   */
  cancel(requestId) {
    const wireId = this.#requestIds.get(requestId);
    if (wireId === undefined) return false;
    this.#requestIds.delete(requestId);
    const pending = this.#pending.get(wireId);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(wireId);
      const err = new Error('Cancelled.');
      err.cancelled = true;
      pending.reject(err);
    }
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: wireId, reason: 'cancelled by the user or the queue budget' } }));
    }
    return true;
  }

  async refreshTools() {
    const tools = [];
    const seen = new Set();
    let cursor;
    let pages = 0;
    do {
      if (pages >= 50 || (cursor && seen.has(cursor))) break; // a server repeating nextCursor must not hang the handshake
      pages += 1;
      if (cursor) seen.add(cursor);
      const res = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(res.tools ?? []));
      cursor = res.nextCursor;
    } while (cursor);
    this.tools = tools;
    this.onChange({ kind: 'tools' });
  }

  // ───────────────────────── Internals ─────────────────────────

  async #handshake() {
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'longarm', version: chrome.runtime?.getManifest?.()?.version ?? '0' },
    });
    this.serverInfo = init?.serverInfo ?? null;
    this.notify('notifications/initialized');
    await this.refreshTools();

    this.lastError = null;
    this.#attempt = 0;
    this.#setStatus('connected');
    this.#resolveReady();
    this.#startKeepalive();
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return; // a late answer after a timeout/cancel: nothing is waiting for it
      this.#pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.forget?.();
      if (msg.error) pending.reject(new Error(msg.error.message ?? 'MCP error'));
      else pending.resolve(msg.result);
      return;
    }

    // Notifications / requests from the server
    if (msg.method === 'notifications/tools/list_changed') {
      this.refreshTools().catch(() => {});
    } else if (msg.method && msg.id !== undefined) {
      const result = msg.method === 'ping' ? { result: {} }
        : { error: { code: -32601, message: 'Method not supported by LongArm' } };
      this.#ws?.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...result }));
    }
  }

  #teardown() {
    clearInterval(this.#keepaliveTimer);
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new Error('Connection closed.'));
    }
    this.#pending.clear();
    this.#requestIds.clear();
    this.tools = [];
    if (this.status === 'connected') this.#resetReady();
  }

  #resetReady() {
    this.#ready = new Promise((resolve) => { this.#resolveReady = resolve; });
  }

  #startKeepalive() {
    clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = setInterval(() => {
      // With no reply to the ping the connection is «zombie» (computer sleep, network…): it is closed so it reconnects on its own.
      this.request('ping', {}, 8000).catch(() => { try { this.#ws?.close(); } catch { /* noop */ } });
    }, KEEPALIVE_MS);
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.#attempt) + Math.random() * 500;
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  #setStatus(next) {
    const prev = this.status;
    this.status = next;
    if (prev !== next) this.onChange({ kind: 'status', prev, next });
  }
}
