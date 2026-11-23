/**
 * base_adapter.js — Base class of the Adapter pattern.
 *
 * Each platform (ChatGPT, Gemini, Claude) extends `BaseAdapter` and ONLY declares:
 *   - `matches(hostname)`
 *   - the DOM selectors (several candidates per element, in priority order)
 *   - optionally `getMessageKey()` if the site exposes a stable ID per message.
 *
 * Interface every adapter implements (inherited from this class):
 *   - observeResponses(callback)           → detects `mcp_call` calls in the responses.
 *   - attachFiles(files)                   → attaches images/files to the text box.
 *   - sendMessage(text, options)           → writes a message (the bridge's answer, or a tool result) and sends it.
 *   - sendToolResult(text)                 → sendMessage + the response watcher is told (repeat detection).
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const BASELINE_MS = 2500;     // window after loading/navigating in which nothing is considered a live turn
  const DEBOUNCE_MS = 800;      // the message must stay stable this long before being analysed
  const POLL_MS = 1000;         // heartbeat: safety net in case the MutationObserver misses a change
  const WAKE_MS = 30_000;       // hidden tab waiting for a reply with no DOM changes → it is woken up briefly
  const STUCK_MS = 2500;        // stable text with the "generating" indicator stuck → taken as finished
  const FRESH_CHAT_MS = 120_000;
  const STORE_KEY = 'wmb:executed';
  const DELIVERED_KEY = 'wmb:delivered';
  const EXECUTED_AT_KEY = 'wmb:executed-at';
  const NEW_CHAT_KEY = 'wmb:new-chat';
  const PENDING_MAX_AGE_MS = 15 * 60_000; // an old "executed but not delivered" call is NOT resumed
  const STORE_LIMIT = 500;
  const DOCUMENT_POSITION_FOLLOWING = 4;

  /**
   * The user's own turns, for the sites that declare none (DeepSeek, and any new adapter): a call is only ever
   * live when it sits AFTER the last user message of the page. Rehydrated history always sits before it.
   */
  const USER_FALLBACK = [
    '[data-message-author-role="user"]',
    '[data-turn="user"]',
    '[data-testid="user-message"]',
    '.font-user-message',
    'user-query',
  ].join(',');

  class BaseAdapter {
    #sigCache = new WeakMap(); // element → {text, signature}; the call itself is the stable identity

    /**
     * @param {{id:string,name:string,selectors:{composer:string[],sendButton:string[],assistantMessages:string[],stopButton:string[],userMessages?:string[],fileInput?:string[]}}} config
     *   `userMessages` is the user's own turns; `hide.js` reads it (with `assistantMessages`) so the cleanup of
     *   the page and the call detection always agree on what a message is.
     */
    constructor({ id, name, selectors }) {
      this.id = id;
      this.name = name;
      this.selectors = selectors;
      this.executed = this.#loadExecuted();
      this.executedAt = this.#loadExecutedAt();
      this.delivered = this.#loadDelivered();
      this.deliveries = 0;            // results delivered to the AI (to tell real repeats from repaints)
      this.staged = [];               // results left in the composer by autoSend=false, awaiting a real send
      this.composerAtSend = '';       // what the composer held at the last TRUSTED send event
      this.lastUserSendAt = 0;        // when that trusted send happened (never a manual clear)
      this.lastDeliveryAt = 0;
      this.genSinceDelivery = false;  // the AI already replied after the last delivered result
      this.msgsAtDelivery = 0;
      this.baselineUntil = 0;
      this.lastActivity = 0;
      this.freshChat = false;
      this.newChatToken = null;       // unique identity of the CURRENT new chat (path "/", "/new", "/app")
      this.lastAssistantCount = 0;    // to tell "same new chat, another turn" from "a fresh new chat"
      this.liveThreadEl = null;       // the reply element of the current turn (adoption requires it in the DOM)
      this.liveReplySig = null;       // content signature of that reply (survives a same-chat re-render)
      this.liveReplyCount = 0;
      this.liveUserSig = null;        // signature of the user turn it answers (anti-B-leak)
      this.awaitingSince = 0;   // when something was sent and a new reply is awaited
      this.turnStartedAt = 0;   // when a turn that may legitimately fire a call began in this page session
      this.turnStartMsgs = 0;   // assistant messages that already existed when that turn began
      this.options = { focusFallback: true };
      this.rescan = () => {};
    }

    /** Settings coming from the extension (e.g. `focusFallback`). */
    configure(options) { Object.assign(this.options, options); }

    /** @param {string} hostname */
    matches(_hostname) { return false; }

    // ───────────── DOM access ─────────────

    getComposer() { return WMB.firstVisible(this.selectors.composer, document, { loose: true }); }
    getSendButton() { return WMB.firstVisible(this.selectors.sendButton, document, { loose: true }); }
    getAssistantMessages() { return WMB.allMatches(this.selectors.assistantMessages); }
    isStreaming() { return WMB.exists(this.selectors.stopButton); }

    /**
     * The identity of a message for the ledger: the CALLS it carries (their JSON), never the whole text.
     * The AI may add prose after a call (or the renderer may repaint text of the same length), and the call
     * itself has not changed: it must keep its id. Messages without a call fall back to their text.
     */
    #messageSignature(element) {
      const text = element.textContent || '';
      const hit = this.#sigCache.get(element);
      if (hit && hit.text === text) return hit.signature;
      let signature;
      try {
        const calls = WMB.extractMcpCalls?.(text) ?? [];
        signature = WMB.hash(calls.length ? JSON.stringify(calls) : text);
      } catch {
        signature = WMB.hash(text);
      }
      this.#sigCache.set(element, { text, signature });
      return signature;
    }

    /**
     * Stable key of a message; used to avoid repeating calls. A site without a message id (Claude, Gemini)
     * gets the CALL signature plus the occurrence number: text growth/reordering does not rename it, while
     * two identical messages still stay distinct. The conversation is added by #scoped, not here.
     */
    getMessageKey(element, index) {
      const holder = element.closest('[data-message-id], [data-turn-id]') ?? element;
      const explicit = holder.getAttribute('data-message-id') || holder.getAttribute('data-turn-id');
      if (explicit) return explicit;
      const signature = this.#messageSignature(element);
      let occurrence = 0;
      try {
        const messages = this.getAssistantMessages();
        for (let i = 0; i < Math.min(index, messages.length); i += 1) {
          if (this.#messageSignature(messages[i]) === signature) occurrence += 1;
        }
      } catch { /* no DOM: the hash alone is still better than a position */ }
      return `${signature}:${occurrence}`;
    }

    /** Public form of the content signature (the ChatGPT observer needs it too). */
    messageSignature(element) {
      return this.#messageSignature(element);
    }

    /**
     * Is the thread on screen still the one this turn's reply belongs to, even if the element was replaced
     * by a re-render? Compare the reply's content signature, the message count and the user turn it answers.
     * Different chat → different reply/user text → false (the element shortcut alone covers the normal case).
     */
    sameLiveThread(messages) {
      if (!this.liveReplySig || !messages.length) return false;
      if (messages.length !== this.liveReplyCount) return false;
      const last = messages[messages.length - 1];
      if (!last || this.#messageSignature(last) !== this.liveReplySig) return false;
      let userSig = null;
      try {
        const users = this.getUserMessages();
        if (users.length) userSig = WMB.hash(users[users.length - 1].textContent || '');
      } catch { /* no DOM */ }
      return (this.liveUserSig ?? null) === userSig;
    }

    /**
     * Which conversation the page shows right now. A call detected in one conversation must never be executed
     * or delivered in another, so every adapter answers this and the controller compares it at detection,
     * execution and delivery.
     */
    conversationKey() {
      return typeof location !== 'undefined' ? location.pathname : '';
    }

    /**
     * A chat whose id is not in the URL yet (ChatGPT assigns /c/<id>, DeepSeek /s/<id> once the first reply
     * starts). The default path names the conversation, so it is never "new"; the two adapters that behave
     * otherwise override it.
     */
    isNewChatPath(path) {
      return path === '/' || path === '';
    }

    /**
     * The identity used for DELIVERY and the ledger. A new-chat path ("/", "/new", "/app") is the same string
     * for EVERY new chat, so it cannot identify one: while the URL has no id, a unique token (created when the
     * turn starts) is the conversation. Two new chats opened in a row therefore never share an identity.
     */
    conversationIdentity() {
      return this.newChatToken || this.conversationKey();
    }

    /**
     * Creates the unique token for a new chat when a turn starts. It is NOT recreated on every send in the
     * same new chat (a running result must still deliver), only when the thread was emptied for a NEW chat.
     */
    armNewChatToken() {
      const path = typeof location !== 'undefined' ? location.pathname : '';
      const count = this.getAssistantMessages().length;
      if (!this.isNewChatPath(path)) {
        this.newChatToken = null;
        this.lastAssistantCount = count;
        this.persistNewChatToken(); // removes the stored token: this is a real chat
        return;
      }
      const freshThread = count === 0 && this.lastAssistantCount > 0;
      if (!this.newChatToken || freshThread) this.newChatToken = `new:${WMB.generateUuid()}`;
      this.lastAssistantCount = count;
      this.persistNewChatToken();
    }

    /** A stable signature of the restored thread, to tell "the same new chat after reload" from a new one. */
    threadSignature() {
      try {
        return WMB.hash(this.getAssistantMessages().map((message) => this.#messageSignature(message)).join('|'));
      } catch { return ''; }
    }

    /**
     * Reload of a new chat whose URL never arrived: the token must survive, or the ledger entries written
     * under it (and the pending call that needs a retry) become invisible. It is reused only when the
     * restored thread is the SAME one (path + message signatures); an empty/different new chat gets a new
     * token when its turn starts.
     */
    restoreNewChatToken() {
      try {
        const path = typeof location !== 'undefined' ? location.pathname : '';
        if (!this.isNewChatPath(path)) { sessionStorage.removeItem(NEW_CHAT_KEY); return; }
        const saved = JSON.parse(sessionStorage.getItem(NEW_CHAT_KEY) || 'null');
        if (!saved?.token || saved.path !== path) return;
        const messages = this.getAssistantMessages();
        if (!messages.length || saved.sig !== this.threadSignature()) { sessionStorage.removeItem(NEW_CHAT_KEY); return; }
        this.newChatToken = saved.token;
        this.lastAssistantCount = messages.length;
      } catch { /* storage unavailable: the in-memory flow still works */ }
    }

    persistNewChatToken() {
      try {
        if (!this.newChatToken) { sessionStorage.removeItem(NEW_CHAT_KEY); return; }
        sessionStorage.setItem(NEW_CHAT_KEY, JSON.stringify({
          token: this.newChatToken,
          path: typeof location !== 'undefined' ? location.pathname : '',
          sig: this.threadSignature(),
          count: this.getAssistantMessages().length,
        }));
      } catch { /* storage unavailable */ }
    }

    /**
     * The page moved from a chat without an id to its real one: the SAME conversation. The ledger entries
     * (executed/delivered) move with it, and `isSameConversation` keeps accepting the old identity, so a request
     * detected a moment before the URL arrived still delivers.
     */
    adoptConversation(from, to) {
      if (from === to) return;
      const prefix = `${from}\u0000`;
      const remap = (set) => {
        let changed = false;
        for (const key of Array.from(set)) {
          if (!key.startsWith(prefix)) continue;
          set.delete(key);
          set.add(`${to}\u0000${key.slice(prefix.length)}`);
          changed = true;
        }
        return changed;
      };
      const remapTimes = () => {
        let changed = false;
        for (const [key, at] of Array.from(this.executedAt)) {
          if (!key.startsWith(prefix)) continue;
          this.executedAt.delete(key);
          this.executedAt.set(`${to}\u0000${key.slice(prefix.length)}`, at);
          changed = true;
        }
        return changed;
      };
      try {
        if (remap(this.executed)) sessionStorage.setItem(STORE_KEY, JSON.stringify(Array.from(this.executed).slice(-STORE_LIMIT)));
        if (remap(this.delivered)) sessionStorage.setItem(DELIVERED_KEY, JSON.stringify(Array.from(this.delivered).slice(-STORE_LIMIT)));
        if (remapTimes()) sessionStorage.setItem(EXECUTED_AT_KEY, JSON.stringify(Object.fromEntries(this.executedAt)));
      } catch { /* storage unavailable: the in-memory sets are updated anyway */ }
      this.conversationAlias = { from, to };
      if (this.newChatToken === from) this.newChatToken = null; // the real URL is the identity from now on
      this.persistNewChatToken();
    }

    /**
     * Does the page still show the conversation a request belonged to?
     * A request detected while the chat had no id yet (the URL is assigned after the first send on ChatGPT and
     * DeepSeek) is a wildcard: it becomes the conversation it was sent from, so opening a NEW chat later must not
     * let it match every other one.
     */
    isSameConversation(conversation) {
      if (conversation === null || conversation === undefined) return true;
      const current = this.conversationIdentity();
      if (current === conversation) return true;
      // A request detected under the token of THIS new chat still belongs to it once the URL arrives.
      return Boolean(this.conversationAlias
        && this.conversationAlias.from === conversation
        && (this.conversationAlias.to === current || this.conversationAlias.to === this.conversationKey()));
    }

    /**
     * Is the page still on the TURN (the user message) that produced this request? A result from an old
     * turn typed after the user started a new one would answer the wrong prompt — the exact "result of the
     * previous request appears in the next turn" symptom.
     */
    isSameTurn(turn) {
      return turn === null || turn === undefined || turn === this.turnStartedAt;
    }

    /** The user's own turns, for the positional "this call answers the latest message" check. */
    getUserMessages() {
      const selectors = this.selectors.userMessages?.length ? this.selectors.userMessages : [USER_FALLBACK];
      return WMB.allMatches(selectors);
    }

    /**
     * The page showed activity (a user bubble was rendered, a repaint happened). It is NOT a send: it must never
     * arm a turn, or a chat that renders its history bubble by bubble would let its old calls run.
     */
    noteActivity() {
      this.lastActivity = Date.now();
    }

    /**
     * The user (or the extension on their behalf) started a new turn: from now on the AI's NEXT reply is live.
     * Everything already on the page stays history — that is what stops a chat that is merely re-rendered from
     * running its old calls.
     */
    /**
     * @param {{trustedSend?:boolean}} options `trustedSend:false` is a REGENERATE: it starts a live turn
     *   (its reply may carry calls) but it is NOT a send of whatever sits in the composer.
     */
    markActivity({ trustedSend = true } = {}) {
      // A TRUSTED send (the core calls this only from isTrusted Enter/click): remember what the composer
      // held at that moment. A staged result is delivered only if it was part of THIS send.
      if (trustedSend) {
        let composer = null;
        try { composer = this.getComposer(); } catch { /* no DOM in a unit test */ }
        this.composerAtSend = composer ? WMB.dom.getText(composer) : '';
        this.lastUserSendAt = Date.now();
      }
      this.lastActivity = Date.now();
      this.awaitingSince = this.lastActivity;
      this.turnStartedAt = this.lastActivity;
      this.liveThreadEl = null; // the previous reply never authorizes a URL adoption for this new turn
      this.liveReplySig = null;
      this.liveReplyCount = 0;
      this.liveUserSig = null;
      this.armNewChatToken(); // unique identity while the URL has no chat id
      this.turnStartMsgs = this.getAssistantMessages().length;
      this.baselineUntil = 0;
      this.freshChat = this.turnStartMsgs === 0; // first message of a new chat
    }

    /**
     * With `autoSend=false` the result is STAGED in the composer, not delivered. When the user presses Enter
     * themselves (the chat starts generating or a new message appears), it becomes delivered; otherwise it
     * stays pending (safe: it may run again after a reload). A cleared composer with no generation is NOT a
     * send — that is the user changing their mind.
     */
    trackStagedDelivery(messages, streaming) {
      if (!this.staged?.length) return;
      const compact = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const composer = this.getComposer();
      const current = compact(composer ? WMB.dom.getText(composer) : '');
      const sentText = compact(this.composerAtSend);
      this.staged = this.staged.filter((entry) => {
        if (!this.isSameConversation(entry.conversation)) return false; // belongs to another chat now
        const marker = compact(entry.text).slice(0, 60);
        const stillThere = marker && current.includes(marker);
        // The result must have been IN the composer at a trusted send, and that send must have gone out
        // (generation/new message) and cleared it. Manual clearing + an unrelated message is not a send.
        const trustedSend = Boolean(marker)
          && this.lastUserSendAt > entry.at
          && Date.now() - this.lastUserSendAt < 120_000
          && sentText.includes(marker);
        const moved = Boolean(streaming) || messages.length > entry.msgs;
        if (trustedSend && moved && !stillThere) {
          if (entry.callIds?.length) this.markDelivered(entry.callIds);
          // The result is IN the chat now: arm the same delivery bookkeeping a confirmed auto-send arms, or
          // a repeat in the AI's next reply would be mistaken for a repaint of the message that asked.
          this.lastDeliveryAt = Date.now();
          this.msgsAtDelivery = messages.length;
          this.deliveries += 1;
          // ChatGPT counts call BLOCKS instead of messages: it must learn about this delivery the same way
          // it learns about an auto-send, or a repaint could look like a repeat.
          if (typeof this.onDelivery === 'function') this.onDelivery();
          return false;
        }
        return Date.now() - entry.at < 300_000; // far too old to be waiting for the same send
      });
    }

    // ───────────── Public interface ─────────────

    /**
     * Watches the DOM and calls `callback({id, call, element})` when the assistant
     * finishes writing a message containing a NEW MCP call.
     * `onDone({text, element})` is called once per finished response WITHOUT an MCP call.
     * All timers use `WMB.sleep`: they keep working with the tab hidden or the window covered.
     * @returns {() => void} function to stop watching
     */
    observeResponses(callback, { onDone } = {}) {
      let alive = true;
      let scheduled = false;
      let lastTick = 0;
      let lastSig = '';
      let lastText = '';
      let lastDone = '';
      let stableSince = Date.now();
      let conv = this.conversationKey();
      let resumed = new Set();   // calls fired in this TAB whose result never arrived: run once per page load
      const historySeen = new Set(); // ids of calls found in the restored history (this page load only)
      this.restoreNewChatToken(); // a reload before the new chat got its URL still knows its token
      this.baselineUntil = Date.now() + BASELINE_MS;
      this.turnStartedAt = 0;
      this.turnStartMsgs = this.getAssistantMessages().length;

      // At most one scan every `delay` ms while there are changes (without piling up timers).
      const schedule = (delay = DEBOUNCE_MS) => {
        if (scheduled) return;
        scheduled = true;
        WMB.sleep(delay).then(() => { scheduled = false; if (alive) scan(); });
      };

      /** The page moved to another conversation: nothing seen in the previous one may fire or be repeated. */
      const followConversation = (messages) => {
        const nowConv = this.conversationKey();
        if (nowConv === conv) return false;
        const previous = conv;
        conv = nowConv;
        // A chat that had no id received one (the first reply assigns it): the SAME conversation. Its ledger
        // moves along and the turn stays armed — otherwise the very reply that produced the call would be
        // disarmed as a "navigation" and the call would never run. The token is the new chat's identity; the
        // path is only a fallback for a page that never started a turn.
        // The SAME thread must still be on the page: if opening chat B replaced it, its elements (and the
        // reply this turn is about) are gone, so this is a navigation, NOT the new chat getting its URL.
        const connected = Boolean(this.liveThreadEl && typeof document !== 'undefined' && document.contains(this.liveThreadEl));
        // Element identity covers the normal case; a SPA re-render of the same reply keeps the content
        // signature (and the user turn) identical, so the same chat still adopts its real URL.
        const sameThread = connected || this.sameLiveThread(messages);
        if (this.turnStartedAt && this.isNewChatPath(previous) && messages.length <= 2 && sameThread) {
          const from = this.newChatToken && this.isNewChatPath(previous) ? this.newChatToken : previous;
          this.adoptConversation(from, nowConv);
          this.liveThreadEl = null;
          this.liveReplySig = null;
          return false;
        }
        this.genSinceDelivery = false;
        this.lastDeliveryAt = 0;
        this.awaitingSince = 0;
        this.freshChat = false;
        this.newChatToken = null; // a real navigation: the old new-chat token must never match again
        this.liveThreadEl = null;
        this.liveReplySig = null;
        this.liveReplyCount = 0;
        this.liveUserSig = null;
        this.turnStartedAt = 0;
        this.turnStartMsgs = messages.length;
        this.baselineUntil = Date.now() + BASELINE_MS;
        // History indexed for the PREVIOUS conversation must not make an identical call in this one look
        // like restored history (the ids carry no conversation; the ledger is what scopes them).
        historySeen.clear();
        lastSig = '';
        lastDone = '';
        lastText = '';
        return true;
      };

      /**
       * Is this assistant message the reply to a turn that started in THIS page session?
       * Only a live turn may fire a call. Opening a chat, switching chats or re-rendering history never starts
       * one, which is what stops an old `mcp_call` from running just because it is on screen.
       */
      const isLiveTurn = (messages, index, streaming) => {
        if (!this.turnStartedAt) return false;
        if (index !== messages.length - 1) return false;      // a call is only live as the last reply
        if (streaming) return true;                           // the reply is still being written: live by definition
        return messages.length > this.turnStartMsgs;          // a new assistant message appeared after the turn began
      };

      /** The call's message must sit after the last user turn (history is always rendered before it). */
      const answersLatestUserTurn = (element) => {
        const users = this.getUserMessages();
        const lastUser = users.length ? users[users.length - 1] : null;
        if (!lastUser || typeof element.compareDocumentPosition !== 'function') return true;
        // lastUser follows element ⇒ element belongs to an earlier turn, which is history.
        return !(element.compareDocumentPosition(lastUser) & DOCUMENT_POSITION_FOLLOWING);
      };

      const scan = () => {
        const now = Date.now();
        const streaming = this.isStreaming();
        const messages = this.getAssistantMessages();
        this.lastAssistantCount = Math.max(this.lastAssistantCount, messages.length);
        this.trackStagedDelivery(messages, streaming);
        // A real navigation may still expose the PREVIOUS thread for a paint (the URL changes first): do not
        // index that stale DOM as the new conversation's baseline — the next scan sees the real thread.
        if (followConversation(messages)) { schedule(100); return; }
        if (this.lastDeliveryAt && (streaming || messages.length > this.msgsAtDelivery)) this.genSinceDelivery = true;
        if (streaming) {
          this.lastActivity = now;
          this.baselineUntil = 0;                              // there is live generation: the conversation is not "old"
          // Generation in this page session IS a live turn, even when no trusted send event reached us.
          if (!this.turnStartedAt) {
            this.turnStartedAt = now;
            this.armNewChatToken(); // generation without a trusted send event still identifies its chat
            this.turnStartMsgs = Math.max(0, messages.length - 1); // the message being written is the new one
          }
          if (messages.length <= 1) this.freshChat = true;     // first reply of a new chat
        } else if (messages.length > 2) this.freshChat = false;
        if (!messages.length) return;

        let last = -1;
        for (let i = messages.length - 1; i >= 0 && last < 0; i -= 1) if ((messages[i].textContent || '').trim()) last = i;
        const text = last >= 0 ? messages[last].textContent : '';
        // Remember the reply this turn is about: a URL adoption is only valid while that SAME element is
        // still on the page (a navigation to another chat replaced the thread, so it is gone).
        if (last >= 0 && (streaming || this.turnStartedAt)) {
          this.liveThreadEl = messages[last];
          this.liveReplySig = this.#messageSignature(messages[last]);
          this.liveReplyCount = messages.length;
          try {
            const users = this.getUserMessages();
            this.liveUserSig = users.length ? WMB.hash(users[users.length - 1].textContent || '') : null;
          } catch { this.liveUserSig = null; }
        }
        if (text !== lastText) { lastText = text; stableSince = now; this.awaitingSince = 0; } // new content arrived

        // With "generating" active it waits, unless the text has been stable for a while (stuck indicator).
        if (streaming && now - stableSince < STUCK_MS) { schedule(1000); return; }

        const baseline = now < this.baselineUntil;
        // Content, not only length: a repaint that replaces the text with another one of the SAME length used
        // to leave the signature unchanged and the scan returned before extracting the new call.
        const sig = `${conv}|${messages.length}|${last}|${text.length}|${WMB.hash(text)}`;
        if (!baseline && sig === lastSig) return;
        lastSig = sig;

        // Baseline: the conversation being restored is ONLY memorised — never run, and never persisted, so a
        // restored chat can never be mistaken for a pending request on the next load.
        const indexes = baseline ? messages.map((_, i) => i) : (last >= 0 ? [last] : []);
        for (const i of indexes) {
          const element = messages[i];
          const messageText = i === last ? text : (element.textContent || '');
          // The extension's own result / tool-list message is DATA, never a request: a command output that
          // happens to contain an `mcp_call` must not be executed (defense in depth where a site renders the
          // result outside the declared user selector, as DeepSeek does).
          if (WMB.isBridgeMessage?.(messageText)) continue;
          const calls = WMB.extractMcpCalls(messageText);
          if (calls.length) {
            const isRepeatTurnGuess = !baseline && isLiveTurn(messages, i, streaming) && !streaming && this.genSinceDelivery;
            const callIds = calls.map((call, n) => {
              let id = `${this.getMessageKey(element, i)}#${n}:${WMB.hash(JSON.stringify(call))}`;
              if (!baseline && this.hasExecuted(id) && isRepeatTurnGuess) id = `${id}~r${this.deliveries}`;
              return id;
            });
            const primaryId = callIds[0];
            if (baseline) {
              // Restored history: remembered for THIS page load only. Nothing is written to the tab ledger.
              callIds.forEach((id) => historySeen.add(id));
              continue;
            }
            this.persistNewChatToken(); // the thread signature a reload needs to find this pending call
            // Fired in this TAB in THIS conversation but its result never reached the chat (the page was reloaded
            // mid-run): the AI is still waiting, so it runs once on this page load. A precise, persisted signal —
            // it needs no live turn.
            const pending = callIds.some((id) => this.isPending(id) && !resumed.has(id));
            const answersLatest = answersLatestUserTurn(element);
            // ...but only while this still IS the latest turn. If the user has sent another message since
            // (the reply sits BEFORE the last user turn), re-running the side effect to recover its result
            // would answer a prompt the conversation has already moved past: drop it for good instead.
            if (pending && !answersLatest) {
              this.markDelivered(callIds);
              this.debug?.('ok', 'A pending result belongs to an older turn: dropped instead of run again.');
              continue;
            }
            const liveTurn = isLiveTurn(messages, i, streaming) && answersLatest;
            const fresh = callIds.some((id) => !this.hasExecuted(id) && !historySeen.has(id));
            // A call already covered by the ledger (executed, or restored history) is not a new request.
            if ((liveTurn && fresh) || pending) {
              // Recorded BEFORE the callback: the next scan of the same message must see it as done.
              callIds.forEach((id) => { this.rememberExecuted(id); resumed.add(id); });
              // A readable call next to an unreadable one: the readable ones run and the broken one is reported
              // (the parser used to return as soon as one call was read, swallowing the broken sibling).
              const badText = !streaming && WMB.malformedCallBlocks ? (WMB.malformedCallBlocks(messageText)[0] ?? null) : null;
              callback({ id: primaryId, call: calls[0], calls, ids: callIds, element, extra: 0, conversation: this.conversationIdentity(), turn: this.turnStartedAt, badText });
            }
          }
          if (!baseline && i === last && !calls.length && !streaming && WMB.looksMalformed?.(messageText)) {
            // There is MCP call intent but the block could not be read: the AI is warned (it used to be left waiting).
            const badId = `${this.getMessageKey(element, i)}#bad:${WMB.hash(messageText)}`;
            if (!this.hasExecuted(badId) && this.turnStartedAt) { this.rememberExecuted(badId); callback({ id: badId, malformed: true, text: messageText, element, conversation: this.conversationIdentity(), turn: this.turnStartedAt }); }
          }
          if (!baseline && i === last && !calls.length && !streaming && onDone) {
            const doneKey = `${this.getMessageKey(element, i)}:${messageText.length}`;
            if (doneKey !== lastDone) { lastDone = doneKey; onDone({ text, element }); }
          }
        }
      };
      this.rescan = () => { lastSig = ''; lastDone = ''; scan(); };

      const observer = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastTick > 300) {
          lastTick = now;
          if (this.isStreaming()) { this.lastActivity = now; this.baselineUntil = 0; }
        }
        schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      // On returning to the tab / regaining focus: immediate scan (in case something happened while it was hidden).
      const wake = () => { if (!document.hidden) this.rescan(); };
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('focus', wake);

      // Heartbeat every second (replaces setInterval, which freezes in the background): SPA navigation, scan and wake-up.
      let href = location.href;
      (async () => {
        while (alive) {
          const idle = !this.awaitingSince && Date.now() - this.lastActivity > 60_000; // no activity: more spaced-out heartbeat
          await WMB.sleep(idle ? POLL_MS * 3 : POLL_MS);
          if (!WMB.extensionAlive()) alive = false; // the extension reloaded: this script is orphaned and stops
          if (!alive) break;
          if (location.href !== href) {
            href = location.href;
            // A NEW chat gets its URL (/c/<id>) once there is a reply: it is not another conversation and must NOT be memorised.
            if (this.freshChat && Date.now() - this.lastActivity < FRESH_CHAT_MS) this.freshChat = false;
            else {
              this.newChatToken = null;
              this.liveReplySig = null;
              this.liveReplyCount = 0;
              this.liveUserSig = null;
              this.turnStartedAt = 0;
              this.baselineUntil = Date.now() + BASELINE_MS;
            }
          }
          scan();
          await this.#wakeIfStale();
        }
      })();

      return () => {
        alive = false;
        observer.disconnect();
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('focus', wake);
      };
    }

    /**
     * HIDDEN tab waiting for a reply that has gone 30 s without any change or "generating" indicator:
     * some sites do not paint in the background. The tab is brought to the front for a moment and the previous one restored.
     */
    async #wakeIfStale() {
      if (!this.awaitingSince || !this.options.focusFallback || !document.hidden || this.isStreaming()) return;
      if (Date.now() - this.awaitingSince < WAKE_MS || this.wokeFor === this.awaitingSince) return;
      this.wokeFor = this.awaitingSince;
      const token = await WMB.bg({ type: 'FOCUS_TAB' });
      await WMB.sleep(1500);
      this.rescan();
      if (token?.prev) WMB.bg({ type: 'RESTORE_FOCUS', prev: token.prev });
    }

    /**
     * Attaches files (images, audio, long text…) to the chat text box.
     * Tries, in order: paste → drop (drag & drop) → <input type="file">.
     * @param {{name:string,mime:string,b64?:string,text?:string}[]} files
     * @returns {Promise<boolean>} true if the attachment appeared in the interface
     */
    async attachFiles(files) {
      const composer = await WMB.waitFor(() => this.getComposer(), { timeout: 5000 });
      if (!composer) return false;
      let list;
      try { list = files.map(WMB.dom.fileFrom); } catch { return false; }

      const root = composer.closest('form, fieldset') ?? composer.parentElement?.parentElement?.parentElement ?? composer;
      const before = root.getElementsByTagName('*').length;
      const grew = async () => {
        for (let i = 0; i < 10; i += 1) {
          await WMB.sleep(300);
          if (root.getElementsByTagName('*').length - before >= 3) return true; // the attachment thumbnail/chip appeared
        }
        return false;
      };
      /** The file's own name is the reliable signal: a chip rendered late would otherwise be attached TWICE. */
      const hasFile = () => {
        try {
          const text = root.textContent || '';
          return list.some((file) => file.name && text.includes(file.name));
        } catch { return false; }
      };
      const attachedNow = async () => (hasFile() || await grew());
      const transfer = () => {
        const dt = new DataTransfer();
        list.forEach((file) => dt.items.add(file));
        return dt;
      };

      this.lastActivity = Date.now();
      composer.focus();
      try {
        composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer(), bubbles: true, cancelable: true }));
        if (await attachedNow()) return true;
      } catch { /* next method */ }
      if (hasFile()) return true; // a slow upload already landed: do NOT attach it a second time
      try {
        const dataTransfer = transfer();
        for (const type of ['dragenter', 'dragover', 'drop']) {
          composer.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
        }
        if (await attachedNow()) return true;
      } catch { /* next method */ }
      if (hasFile()) return true;
      try {
        const inputs = Array.from(document.querySelectorAll(this.selectors.fileInput?.join(',') || 'input[type="file"]'));
        const input = inputs.find((el) => !el.webkitdirectory && (!el.accept || /image|\*/.test(el.accept))) ?? inputs[0];
        if (input) {
          input.files = transfer().files;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          if (await attachedNow()) return true;
        }
      } catch { /* no more methods */ }
      return false;
    }

    /**
     * Writes a message into the chat and (optionally) sends it, CHECKING that the chat accepted it:
     * it retries the send and, if the tab is hidden and it still does not go out, brings it to the front for a moment.
     * It is the send path of every message the extension types into the chat: tool results and the bridge's own
     * answers (the tool list, the notices about a wrong name or an unreadable call).
     * @param {string} text already formatted message
     * @param {{autoSend?:boolean, settleMs?:number, append?:boolean, delivery?:boolean, conversation?:string, turn?:number}} options
     *   `settleMs`: waits for an attachment to finish uploading · `append:false` replaces what is in the text box ·
     *   `delivery`: the message is an MCP result (the response watcher is told about it) ·
     *   `conversation`: the conversation the message belongs to; it is not written when the page moved away ·
     *   `turn`: the user turn that asked; a result from an older turn is not written into a newer one
     */
    async sendMessage(text, { autoSend = true, settleMs = 0, append = true, delivery = false, conversation = null, turn = null } = {}) {
      // A result belongs to the conversation that asked for it. Switching chats (or opening another one) while a
      // tool runs must not type the answer into whatever conversation is on screen now.
      if (!this.isSameConversation(conversation)) {
        return { ok: false, stale: true, error: 'The page moved to another conversation: this result belongs to the previous one.' };
      }
      if (this.isSameTurn && !this.isSameTurn(turn)) {
        return { ok: false, stale: true, turnAdvanced: true, error: 'The user started a new turn: this result belongs to the previous one.' };
      }
      const composer = await WMB.waitFor(() => {
        const c = this.getComposer();
        return c && (!this.isWritingBlock || !this.isWritingBlock(c)) ? c : null;
      }, { timeout: 5000 });
      if (!composer || (typeof this.isWritingBlock === 'function' && this.isWritingBlock(composer))) {
        return { ok: false, error: 'The main chat text box was not found (writing blocks strictly excluded to protect document).' };
      }
      // The conversation (or the user turn) may have changed while waiting for the text box.
      if (!this.isSameConversation(conversation)) {
        return { ok: false, stale: true, error: 'The page moved to another conversation: this result belongs to the previous one.' };
      }
      if (this.isSameTurn && !this.isSameTurn(turn)) {
        return { ok: false, stale: true, turnAdvanced: true, error: 'The user started a new turn: this result belongs to the previous one.' };
      }
      // Never type into a chat that is still generating: some sites QUEUE such a message and post it after
      // the NEXT reply, which is exactly how a result ends up looking like the answer to the wrong call.
      if (autoSend && this.isStreaming()) {
        await WMB.waitFor(() => !this.isStreaming(), { timeout: 10_000, interval: 250 });
      }
      // The wait may have lasted into a NEW user turn (or another chat): re-check before typing.
      if (!this.isSameConversation(conversation) || (this.isSameTurn && !this.isSameTurn(turn))) {
        return { ok: false, stale: true, error: 'The page moved to another conversation or turn while the chat was generating.' };
      }
      const wasStreaming = this.isStreaming();
      this.lastActivity = Date.now();
      if (typeof this.isWritingBlock === 'function' && this.isWritingBlock(composer)) {
        return { ok: false, error: 'Target element is a writing block: aborting write operation.' };
      }
      // The user's draft is never thrown away. With autoSend the draft is restored right after the send;
      // with autoSend=false the result is staged BELOW the draft so neither is lost.
      const draft = append ? '' : (WMB.dom.getText(composer) || '').trim();
      const writeAppend = append || (Boolean(draft) && !autoSend);
      if (!(await WMB.dom.setText(composer, text, { append: writeAppend }))) {
        return { ok: false, error: 'Could not write into the text box.' };
      }
      // autoSend=false only STAGES the text: nothing has reached the chat yet, so the ledger must not say
      // "delivered" (a reload before the user pressed Enter would lose the result forever).
      if (!autoSend) return { ok: true, staged: true, draftKept: Boolean(draft) };
      if (settleMs) await WMB.sleep(settleMs);

      const initialMsgs = this.getAssistantMessages().length;
      const initialText = WMB.dom.getText(composer);
      const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const written = normalize(initialText);
      // Touching the box is safe only while it still holds exactly what WE wrote (or is already empty).
      // Text the user typed while the send was in flight is never wiped by a clear or a draft restore.
      const safeToTouch = () => {
        const current = normalize(WMB.dom.getText(composer));
        return !current || current === written;
      };
      const restoreDraft = async () => {
        if (!draft || !safeToTouch()) return;
        try {
          if (!(WMB.dom.getText(composer) || '').includes(draft)) await WMB.dom.setText(composer, draft, { append: false });
        } catch { /* the draft is still in the tab's memory? nothing else to do */ }
      };

      const attempt = async (timeout) => (await this.submit(timeout)) && (await this.#confirmSent(initialMsgs, initialText, wasStreaming));
      let sent = await attempt(settleMs ? 30_000 : 4000);
      if (!sent) sent = await attempt(4000); // second attempt (button / Enter)
      if (!sent && this.options.focusFallback && WMB.isBackground()) {
        const token = await WMB.bg({ type: 'FOCUS_TAB' });
        await WMB.sleep(800);
        sent = await attempt(4000);
        if (token?.prev) WMB.bg({ type: 'RESTORE_FOCUS', prev: token.prev });
      }
      if (sent) {
        this.awaitingSince = Date.now();
        // Delivery bookkeeping belongs to a CONFIRMED send, not to the text being written into the composer.
        if (delivery) {
          this.deliveries += 1;
          this.lastDeliveryAt = Date.now();
          this.genSinceDelivery = false;
          this.msgsAtDelivery = this.getAssistantMessages().length;
          if (typeof this.onDelivery === 'function') this.onDelivery();
        }
        // Clear composer ONLY after confirmed successful send, and only when it still holds our text.
        if (safeToTouch()) await WMB.dom.clearText(composer);
        await restoreDraft();
      } else {
        await restoreDraft(); // the send failed: keep the user's draft (the result stays pending)
      }
      return sent
        ? { ok: true, draftRestored: Boolean(draft) }
        : { ok: false, error: 'Could not confirm the send to the chat. Press Enter in the chat.', draftRestored: Boolean(draft) };
    }

    /**
     * The MCP result: identical to `sendMessage`, but the response watcher is also told, so it can tell a real
     * repeat of a call (the AI replied after receiving the result) from a page repaint.
     * `options.callIds` marks those calls delivered for the TAB once the chat accepts the message: a reload after
     * that must never run them again.
     * @param {string} text already formatted message
     * @param {{autoSend?:boolean, settleMs?:number, callIds?:string[], conversation?:string}} options `settleMs`: waits for an attachment to finish uploading
     */
    async sendToolResult(text, options = {}) {
      const { callIds, ...rest } = options;
      const sent = await this.sendMessage(text, { append: false, ...rest, delivery: true });
      // Staged (autoSend=false) is not delivered: it must stay pending until the user actually sends it.
      if (sent?.ok !== false && !sent.staged) this.markDelivered(callIds);
      else if (sent?.staged) {
        // One slot used to overwrite the previous staged result: every staged result has its own entry, so
        // one real send can mark them ALL delivered (and a reload never re-runs the forgotten ones).
        this.staged.push({
          callIds: callIds ?? [],
          conversation: rest.conversation ?? null,
          msgs: this.getAssistantMessages().length,
          at: Date.now(),
          text,
        });
      }
      return sent;
    }

    /** The chat accepted the message: the text box emptied or a NEW response started. */
    async #confirmSent(initialMsgs = 0, initialText = '', wasStreaming = false) {
      return Boolean(await WMB.waitFor(() => {
        // Generation that was ALREADY running before our submit is the old turn, not proof of our send.
        if (!wasStreaming && this.isStreaming()) return true;
        if (this.getAssistantMessages().length > initialMsgs) return true;
        const composer = this.getComposer();
        if (composer) {
          const current = WMB.dom.getText(composer).trim();
          if (!current) return true; // the box emptied: the chat took it
          // A short remainder is NOT a send: only a real drop (less than half of what we wrote) counts.
          const written = initialText.trim();
          if (written && current.length < written.length / 2) return true;
        }
        return false;
      }, { timeout: 8000, interval: 200 }));
    }

    /** Clicks the send button (once enabled) or simulates Enter. */
    async submit(timeout = 4000) {
      const button = await WMB.waitFor(() => {
        const b = this.getSendButton();
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, { timeout, interval: 120 });
      if (button) { button.click(); return true; }

      const composer = this.getComposer();
      if (!composer) return false;
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      composer.dispatchEvent(new KeyboardEvent('keydown', init));
      composer.dispatchEvent(new KeyboardEvent('keyup', init));
      return true;
    }

    // ───────────── Registry of executed IDs (persists in the tab) ─────────────

    #loadExecuted() {
      try { return new Set(JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]')); } catch { return new Set(); }
    }

    #loadDelivered() {
      try { return new Set(JSON.parse(sessionStorage.getItem(DELIVERED_KEY) || '[]')); } catch { return new Set(); }
    }

    #loadExecutedAt() {
      try { return new Map(Object.entries(JSON.parse(sessionStorage.getItem(EXECUTED_AT_KEY) || '{}'))); } catch { return new Map(); }
    }

    /**
     * A call id belongs to the CONVERSATION that produced it. `sessionStorage` is per tab, not per chat, so an
     * unscoped ledger let a call fired in one chat answer for an identical call in another (and let a pending one
     * resume there). Scoping is what keeps two conversations from sharing request state.
     */
    #scoped(id) {
      return `${this.conversationIdentity()}\u0000${id}`;
    }

    /** Has this call already been fired in THIS TAB, in THIS conversation (survives a page reload)? */
    hasExecuted(id) {
      return this.executed.has(this.#scoped(id));
    }

    /** Was the result of this call already written into the chat, in THIS conversation? */
    hasDelivered(id) {
      return this.delivered.has(this.#scoped(id));
    }

    /**
     * Fired here, never answered: the page was reloaded (or the tab restored) while the tool ran, and the AI is
     * still waiting. This is the ONE case where a call may run again on a later page load.
     */
    isPending(id) {
      const key = this.#scoped(id);
      if (!this.executed.has(key) || this.delivered.has(key)) return false;
      const at = this.executedAt.get(key);
      // A call fired 15+ minutes ago (or from an older build with no timestamp) is NOT resumed: blindly
      // re-running an ancient side effect on a reload is worse than leaving it unanswered.
      if (!at || Date.now() - at > PENDING_MAX_AGE_MS) {
        this.delivered.add(key);
        this.#trim(this.delivered);
        try { sessionStorage.setItem(DELIVERED_KEY, JSON.stringify(Array.from(this.delivered).slice(-STORE_LIMIT))); } catch { /* noop */ }
        return false;
      }
      return true;
    }

    /** Keeps the in-memory Set as bounded as the snapshot (Set preserves insertion order). */
    #trim(set) {
      while (set.size > STORE_LIMIT) set.delete(set.values().next().value);
    }

    /**
     * Remembers a fired call for the lifetime of the TAB, not just the page. A reloaded page re-renders the whole
     * conversation, and its `mcp_call` blocks look exactly like new ones; without this the same call ran (and the
     * same result was delivered) once per reload.
     */
    rememberExecuted(id) {
      const key = this.#scoped(id);
      if (this.executed.has(key)) return;
      this.executed.add(key);
      this.executedAt.set(key, Date.now());
      this.#trim(this.executed);
      while (this.executedAt.size > STORE_LIMIT) this.executedAt.delete(this.executedAt.keys().next().value);
      try {
        sessionStorage.setItem(STORE_KEY, JSON.stringify(Array.from(this.executed).slice(-STORE_LIMIT)));
        sessionStorage.setItem(EXECUTED_AT_KEY, JSON.stringify(Object.fromEntries(this.executedAt)));
      } catch { /* storage unavailable */ }
    }

    /**
     * The result reached the chat: this call is done for good in THIS conversation. A call that was fired but never
     * marked delivered (the page was reloaded while the tool was running) is the one case where it may run again.
     */
    markDelivered(ids) {
      if (!ids?.length) return;
      let changed = false;
      for (const id of ids) {
        const key = this.#scoped(id);
        if (!this.delivered.has(key)) { this.delivered.add(key); changed = true; }
      }
      if (!changed) return;
      this.#trim(this.delivered);
      try {
        sessionStorage.setItem(DELIVERED_KEY, JSON.stringify(Array.from(this.delivered).slice(-STORE_LIMIT)));
      } catch { /* storage unavailable */ }
    }

  }

  WMB.BaseAdapter = BaseAdapter;
  WMB.adapters = [];
  WMB.registerAdapter = (adapter) => { WMB.adapters.push(adapter); };
  WMB.findAdapter = (hostname) => WMB.adapters.find((a) => a.matches(hostname)) ?? null;
})();
