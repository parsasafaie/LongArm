/**
 * call_registry.js — The ONE semantic repeat-guard of the extension.
 *
 * The AI sometimes sends EXACTLY the same call again; running it twice can repeat a side effect on the
 * user's computer. This registry is the single policy layer that answers "have I seen this call before,
 * inside the window?": it keys a call by its content, counts the repeats inside the window, and keeps the
 * last result so an identical call is ANSWERED instead of run. A real user send and any permission change
 * clear it (the controller calls `clear()`), because both may legitimately allow a call to run again.
 *
 * Memory is bounded on purpose: the window expires an entry, at most MAX_ENTRIES calls are remembered
 * (oldest out first), and a result too large to hold (attachments are base64!) is replaced with a short
 * notice — a long conversation must never grow this map without limit.
 *
 * This is deliberately the only dedup here. The adapters keep their own small DOM bookkeeping (which
 * element on the page was already fired — a property of the page's repaints, not of the conversation);
 * everything that is a property of the CONVERSATION lives here.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB || WMB.CallRegistry) return;

  /** Entries kept at most (the oldest are dropped first). */
  const MAX_ENTRIES = 50;
  /** A result larger than this is not kept: the replay gets a short honest notice instead. */
  const MAX_RESULT_CHARS = 256_000;

  /** What the repeat path stores for a result: the result itself, or a small stand-in when it is huge. */
  function bounded(result) {
    if (!result || typeof result !== 'object') return null;
    let size;
    try { size = JSON.stringify(result).length; } catch { size = Infinity; } // circular: never keep it
    if (size <= MAX_RESULT_CHARS) return result;
    return {
      status: result.status,
      text: `(the previous result was ${size.toLocaleString('en')} characters long and is not kept in memory; the call was not run again)`,
    };
  }

  class CallRegistry {
    /** @type {Map<string, {count:number, at:number, result:object}>} */
    #entries = new Map();

    constructor({ windowMs = WMB.defaults.repeat.windowMs, max = WMB.defaults.repeat.max } = {}) {
      this.windowMs = windowMs;
      this.max = max;
    }

    /** The key of a call: its content, so a repaint of the same message collides and a changed call does not. */
    key(server, name, args) {
      return WMB.hash(JSON.stringify([server, name, args ?? {}]));
    }

    /** The live entry, or null — an expired one is dropped on sight (and never answered from). */
    #live(key) {
      const entry = this.#entries.get(key);
      if (!entry) return null;
      if (Date.now() - entry.at >= this.windowMs) {
        this.#entries.delete(key);
        return null;
      }
      return entry;
    }

    /** How many times this exact call was recorded inside the window (0 = it would run fresh). */
    repeats(key) {
      return this.#live(key)?.count ?? 0;
    }

    /** The result the previous identical run produced, for the replay path (null when there is none). */
    lastResult(key) {
      return this.#live(key)?.result ?? null;
    }

    /** Records a run — or a refusal: a model that resends a refused call gets the same refusal, not a new dialog. */
    record(key, result, count = 1) {
      this.#entries.set(key, { count, at: Date.now(), result: bounded(result) });
      if (this.#entries.size > MAX_ENTRIES) {
        const oldest = [...this.#entries.entries()].sort((a, b) => a[1].at - b[1].at);
        for (const [oldKey] of oldest.slice(0, this.#entries.size - MAX_ENTRIES)) this.#entries.delete(oldKey);
      }
    }

    /** The replayed call counts as another repeat, so the count and the window move with it. */
    bump(key) {
      const entry = this.#live(key);
      if (entry) { entry.count += 1; entry.at = Date.now(); }
    }

    clear() {
      this.#entries.clear();
    }

    /** How many calls are remembered right now (tests and diagnostics). */
    get size() {
      return this.#entries.size;
    }
  }

  WMB.CallRegistry = CallRegistry;
})();
