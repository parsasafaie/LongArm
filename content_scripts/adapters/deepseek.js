/**
 * deepseek.js — Adapter for DeepSeek (chat.deepseek.com).
 *
 * DeepSeek UI particularities:
 *   - The text box is a plain <textarea id="chat-input"> (React): `dom.setText` already handles it.
 *   - The send button has NO aria-label or stable class: it is an icon (`ds-icon-button`) at the end of the bar.
 *     While generating, THAT SAME button becomes "stop": that is why the send here uses Enter and the button is only
 *     clicked when it is known that nothing is generating (otherwise a click WOULD CANCEL the response).
 *   - Responses are rendered in `.ds-markdown`. With "DeepThink" the reasoning also uses Markdown and sometimes
 *     contains a draft of the `mcp_call` call: it is excluded so it does not run twice.
 *   - There is no stable ID per message.
 *
 * Anti-loop (the same result used to be sent over and over):
 *   1. Call ID by CONTENT (how many earlier messages carry the same call; the ledger scopes it by conversation),
 *      not by the message position: if DeepSeek repaints or changes the number of `.ds-markdown` blocks, the call
 *      is not "renewed". The id also stays the same across a reload, so a pending call can be resumed.
 *   2. Lock: after running a call, another IDENTICAL one is ignored until the result is sent and the AI replies
 *      again.
 *   3. Safe send: "send" is not pressed if a generation is in progress, nor if the box is already empty (it already went out).
 *
 * If DeepSeek changes its interface, you usually only need to add a selector to the matching list.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  /** "Reasoning" blocks (DeepThink): their text does not count as the response. */
  const THINK_SEL = '.ds-think-content, [class*="think" i], [class*="reasoning" i]';
  /** Short header that precedes the reasoning ("Thought for 5 seconds", "Thinking…", and the site's Spanish equivalents). */
  const THINK_HEADER = /^(thought|thinking|deepthink|pens[óo]|pensando|razon|reasoning)/i;
  /** Icon buttons (send, attach, stop) and, as a fallback, any ARIA button. */
  const ICON_BUTTONS = ['div[role="button"].ds-icon-button', 'button.ds-icon-button', '.ds-icon-button'];
  const ANY_BUTTONS = ['div[role="button"]', 'button'];

  const GROW_MS = 2000;          // the last message grew less than this long ago → it is generating
  const LOCK_SENT_MS = 90_000;   // lock: after sending the result, this long at most
  const LOCK_MAX_MS = 240_000;   // …and if the result is never sent, this other one at most

  const convId = () => (location.pathname.match(/\/s\/([^/?#]+)/) || [])[1] || null;
  const hashOf = (call) => WMB.hash(JSON.stringify(call) ?? '');

  /** Is it a reasoning block (not the response)? */
  function isThinking(el) {
    if (el.closest(THINK_SEL) || el.querySelector(THINK_SEL)) return true;
    for (let node = el, depth = 0; node && depth < 3; node = node.parentElement, depth += 1) {
      const head = (node.previousElementSibling?.textContent || '').trim();
      if (head && head.length < 45 && THINK_HEADER.test(head)) return true;
    }
    return false;
  }

  class DeepSeekAdapter extends WMB.BaseAdapter {
    #hashCache = new WeakMap();                  // element → {text, set} (hashes of its calls)
    #lock = null;                                // { hash, firedAt, sentAt, newGen }
    #grow = { el: null, len: 0, at: 0 };         // growth tracking of the last message

    constructor() {
      super({
        id: 'deepseek',
        name: 'DeepSeek',
        selectors: {
          composer: [
            'textarea#chat-input',
            'textarea[placeholder*="DeepSeek" i]',
            'textarea[placeholder*="Message" i]',
            'textarea[placeholder*="Mensaje" i]',
            'div[role="textbox"][contenteditable="true"]',
            'textarea',
          ],
          sendButton: [
            // Candidates with an explicit label; the real lookup is done by getSendButton().
            'div[role="button"][aria-label*="Send" i]',
            'button[aria-label*="Send" i]',
            'div[role="button"][aria-label*="Enviar" i]',
            'button[aria-label*="Enviar" i]',
          ],
          assistantMessages: ['.ds-markdown'],
          // DeepSeek's user bubble carries no stable marker today, so there is nothing to declare here: hide.js
          // falls back to its own generic list (see the note in content_scripts/hide.js).
          stopButton: [
            'div[role="button"][aria-label*="Stop" i]',
            'button[aria-label*="Stop" i]',
            'div[role="button"][aria-label*="Detener" i]',
            'button[aria-label*="Detener" i]',
            'div[role="button"][aria-label*="Parar" i]',
            'button[aria-label*="Parar" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com');
    }

    /**
     * The conversation for the ledger and for delivery: the id of the URL, or the root path while the chat has
     * none yet (DeepSeek assigns /s/<id> once the first reply starts). BaseAdapter adopts the ledger when it does.
     */
    conversationKey() {
      const id = convId();
      return id ? `/s/${id}` : (typeof location !== 'undefined' ? location.pathname : '/');
    }

    isNewChatPath(path) {
      return !/\/s\/[^/?#]+/.test(String(path ?? ''));
    }

    // ───────────── Assistant messages (without the reasoning) ─────────────

    getAssistantMessages() {
      const found = super.getAssistantMessages();
      const answers = found.filter((el) => !isThinking(el));
      // If the filter removed everything, not filtering beats going blind.
      const list = answers.length || !found.length ? answers : found;
      // No nested containers (avoids duplicates with broad selectors).
      return list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
    }

    /** Hashes of a message's MCP calls (cached by text). */
    #callHashes(el) {
      const text = el.textContent || '';
      const hit = this.#hashCache.get(el);
      if (hit && hit.text === text) return hit.set;
      const set = new Set(WMB.extractMcpCalls(text).map(hashOf));
      this.#hashCache.set(el, { text, set });
      return set;
    }

    /**
     * Key by CONTENT: number of earlier messages carrying the same call. The conversation itself is added by
     * the base ledger (`#scoped`), so the key stays identical across a reload and a new chat that receives its
     * URL later — the pending call can still be found.
     * It does not depend on the message position, so page repaints do not "renew" an already run call.
     */
    getMessageKey(element, index) {
      const mine = this.#callHashes(element);
      if (!mine.size) return super.getMessageKey(element, index);
      let before = 0;
      for (const other of this.getAssistantMessages()) {
        if (other === element) break;
        for (const hash of this.#callHashes(other)) if (mine.has(hash)) { before += 1; break; }
      }
      return `${before}`;
    }

    // ───────────── Generation in progress ─────────────

    /**
     * Is the AI generating? "Stop" button (if it has a label) or the last message grew moments ago.
     * The button icon is not inspected: if it fails, it would make an old conversation pass as "live".
     */
    isStreaming() {
      let streaming = WMB.exists(this.selectors.stopButton);
      if (!streaming) {
        const messages = this.getAssistantMessages();
        const last = messages[messages.length - 1] ?? null;
        const len = last ? (last.textContent || '').length : 0;
        const now = Date.now();
        if (last && last === this.#grow.el && len > this.#grow.len) this.#grow.at = now; // the SAME message grew
        this.#grow.el = last;
        this.#grow.len = len;
        streaming = now - this.#grow.at < GROW_MS;
      }
      if (streaming && this.#lock?.sentAt) this.#lock.newGen = true; // the AI replied again after sending the result
      return streaming;
    }

    // ───────────── Anti-duplicate lock ─────────────

    #locked(hash) {
      const lock = this.#lock;
      if (!lock || lock.hash !== hash) return false;
      const now = Date.now();
      const expired = lock.sentAt ? (lock.newGen || now - lock.sentAt > LOCK_SENT_MS) : now - lock.firedAt > LOCK_MAX_MS;
      if (expired) { this.#lock = null; return false; }
      return true;
    }

    observeResponses(callback, options) {
      return super.observeResponses((detected) => {
        if (detected.malformed || !detected.call) { callback(detected); return; } // unreadable block notice: it has no call to lock
        const hash = hashOf(detected.call);
        if (this.#locked(hash) && detected.id === this.#lock?.id) { this.debug?.('ok', 'DeepSeek · identical call already in flight: ignored'); return; }
        this.#lock = { hash, id: detected.id, firedAt: Date.now(), sentAt: 0, newGen: false };
        callback(detected);
      }, options);
    }

    async sendToolResult(text, options) {
      try {
        return await super.sendToolResult(text, options);
      } finally {
        if (this.#lock && !this.#lock.sentAt) this.#lock.sentAt = Date.now();
      }
    }

    // ───────────── Send ─────────────

    /** Icon button (no text) furthest right on the text box bar. */
    #composerButtons() {
      const composer = this.getComposer();
      if (!composer) return [];
      let node = composer.parentElement;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        for (const group of [ICON_BUTTONS, ANY_BUTTONS]) {
          const buttons = [];
          for (const selector of group) {
            try { node.querySelectorAll(selector).forEach((b) => { if (!buttons.includes(b)) buttons.push(b); }); } catch { /* noop */ }
          }
          const icons = buttons
            .filter((b) => !b.closest('.ds-toggle-button') && !(b.textContent || '').trim() && b.querySelector('svg, img, i'))
            .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
          if (icons.length) return icons;
        }
      }
      return [];
    }

    getSendButton() {
      const labelled = WMB.firstVisible(this.selectors.sendButton, document, { loose: true });
      if (labelled) return labelled;
      const buttons = this.#composerButtons();
      return buttons.length ? buttons[buttons.length - 1] : null;
    }

    /**
     * Sends with Enter (it does nothing during a generation, so it is safe) and, only if that does not go out, clicks the button,
     * which during a generation is "stop". If the box is already empty it does nothing (it already went out).
     */
    async submit(timeout = 4000) {
      const composer = this.getComposer();
      if (!composer) return false;
      const hasText = () => WMB.dom.getText(composer).trim().length > 0;
      if (!hasText()) return true;

      if (this.isStreaming()) {
        const idle = await WMB.waitFor(() => !this.isStreaming(), { timeout, interval: 200 });
        if (!idle) return false;
      }
      const gone = () => !hasText() || this.isStreaming();

      composer.focus();
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      composer.dispatchEvent(new KeyboardEvent('keydown', init));
      composer.dispatchEvent(new KeyboardEvent('keypress', init));
      composer.dispatchEvent(new KeyboardEvent('keyup', init));
      if (await WMB.waitFor(gone, { timeout: 1500, interval: 150 })) return true;

      const button = await WMB.waitFor(() => {
        const b = this.getSendButton();
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, { timeout, interval: 150 });
      if (button && hasText() && !this.isStreaming()) { button.click(); return true; }
      return !hasText();
    }
  }

  WMB.registerAdapter(new DeepSeekAdapter());
})();