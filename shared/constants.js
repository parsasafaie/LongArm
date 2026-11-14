/**
 * constants.js - Constants shared between the service worker and the popup.
 * (Content scripts are not modules; they receive these values via messages.)
 */

/**
 * Maximum number of MCP servers active at once.
 *
 * Infinity means no ceiling: every usable server can be switched on, which is what you want when you
 * have a toolkit of them installed. Nothing blocks a toggle any more - but the cost the old cap was
 * guarding against has not gone away, so the popup still shows the running tool-token estimate and
 * warns once more than RECOMMENDED_ACTIVE_SERVERS are on. Watch that number: the tool definitions of
 * every active server go into the instructions of each chat (once per chat, not per message).
 */
export const MAX_ACTIVE_SERVERS = Infinity;

/** Recommended number of active servers (more = more context tokens). A warning, not a limit. */
export const RECOMMENDED_ACTIVE_SERVERS = 1;

export const STORAGE_KEYS = {
  servers: 'wmb_servers',
  settings: 'wmb_settings',
  history: 'wmb_history',
  bridge: 'wmb_bridge',
  /** Stamp of the last install/update: a running page whose stamp changed holds a stale copy of the code. */
  epoch: 'wmb_epoch',
};

/** Permission per MCP: allow = never asks · ask = asks on every call · deny = blocked. */
export const PERMISSIONS = ['allow', 'ask', 'deny'];
export const PERMISSION_LABELS = { allow: 'Always allow', ask: 'Always ask', deny: 'Never allow' };

export const DEFAULT_SETTINGS = {
  /** Master switch: when false there are no connections and no injection. */
  bridgeEnabled: true,
  /** Permission the new MCPs get (and the one the global selector shows). */
  defaultPermission: 'ask',
  /** Send the result to the chat automatically. */
  autoSend: true,
  /** Maximum characters of a result inside the message. Anything over it is attached COMPLETE as a file (it is never truncated). */
  maxResultChars: 12000,
  /**
   * Keeps everything the bridge types into the page out of sight: the tool results, the tool list the AI asked
   * for, and the notices about a wrong name or an unreadable call. All of it is still SENT to the AI (hiding is
   * display-only, the text stays in the DOM), and turning this off shows it again. On by default: the chat stays
   * the conversation itself. Anything the extension wrote but no longer writes (an instruction block, a
   * reminder) is recognised and hidden too, so older chats come out clean as well.
   */
  hideProtocol: true,
  /** If the chat will not send with the tab hidden, brings the tab forward for a moment and returns to the previous one. */
  focusFallback: true,
  /** Also enables the detected servers (up to the maximum). If false, only the first one is enabled when none is active. */
  autoEnableDiscovered: false,
  /** Bridge control port (http://127.0.0.1:PORT/servers). */
  controlPort: 8099,
};


export const PROTOCOL_VERSION = '2025-03-26';
export const CALL_TIMEOUT_MS = 120_000;
export const HISTORY_LIMIT = 50;

/**
 * The statuses a result can carry. The installable instruction text, the lenient parser's error notice and the
 * controller all speak of the same four; `content_scripts/constants.js` (generated from here) carries them into
 * the page, where ES modules cannot be imported.
 */
export const RESULT_STATUSES = ['ok', 'error', 'rejected', 'format_error'];

/**
 * The waits the controller uses inside the page. `tool` is deliberately LONGER than `CALL_TIMEOUT_MS`: the page
 * gives up a little after the service worker does, so a timeout is reported by the side that owns the request
 * instead of both racing to answer. `approval` bounds a dialog nobody answered (the queue must not stall).
 */
export const CONTENT_TIMEOUTS = { tool: 150_000, deliver: 120_000, approval: 300_000, heartbeat: 10_000 };

/** An identical call is not run again inside this window: the second one is answered from the previous result. */
export const REPEAT_CALLS = { windowMs: 15 * 60_000, max: 1 };

export const SUPPORTED_URL_PATTERNS = [
  'https://chatgpt.com/*',
  'https://gemini.google.com/*',
  'https://claude.ai/*',
  'https://chat.deepseek.com/*',
];