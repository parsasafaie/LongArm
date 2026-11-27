/**
 * chatgpt.js — Adapter for ChatGPT (chatgpt.com).
 *
 * This adapter uses its OWN observer (not the base adapter's): the ChatGPT UI changes the message
 * container (code viewer) and the `mcp_call` call may sit in a code block, outside the message,
 * or in normal text. That is why it is located by its TEXT, not by message selectors. The PARSING
 * itself is the shared one (`WMB.extractMcpCalls`): its repair layer covers what ChatGPT's Markdown
 * does to backslashes, so this file carries no JSON repair of its own.
 *
 *  - Anti-repeat WITHOUT persistent memory: a call runs only once while it stays visible on the
 *    page; when it disappears (another chat, regenerate…) it is forgotten. Nothing is kept between reloads, so it never
 *    blocks a new task with an "already ran" notice.
 *  - History: if there has been no recent activity (your send or live generation), what is on the page is
 *    old and never runs, no matter how long it takes to load.
 *
 * If OpenAI changes its interface, you usually only need to add a selector to the matching list.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  /** The user's own turns — ONE source, shared by this adapter and by hide.js (which reads selectors.userMessages). */
  const USER_SEL = '[data-message-author-role="user"], [data-turn="user"], [data-testid="user-message"]';

  const CACHE_MS = 300;
  const BASELINE_MS = 2500;   // initial window to index existing calls on load/navigation
  const STABLE_MS = 1200;     // the block must stay unchanged this long
  const STUCK_MS = 2500;      // "generating" stuck: taken as finished after this stable time
  const POLL_MS = 700;
  const FORGET_MS = 8000;     // an executed call is forgotten after this long without being on the page

  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'TR', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE']);
  const SKIP_TAGS = new Set(['BUTTON', 'SVG', 'STYLE', 'SCRIPT', 'NOSCRIPT']);

  /** "Visible" text of a node with line breaks per block / code line. */
  function extractText(root) {
    let out = '';
    const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { out += node.nodeValue; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      if (tag === 'BR') { out += '\n'; return; }
      const isBlock = BLOCK_TAGS.has(tag) || node.classList.contains('cm-line');
      if (isBlock) newline();
      for (const child of node.childNodes) walk(child);
      if (isBlock) newline();
    };
    walk(root);
    return out;
  }

  /** Wraps the element so `textContent` returns the block-aware text (everything else is delegated as is). */
  function wrap(element) {
    return new Proxy(element, {
      get(target, prop) {
        if (prop === 'textContent') return extractText(target);
        if (prop === '__raw') return target;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /** The compact view's own nodes: their text is display, never a request. */
  const OWN_NODES = '[data-wmb-chip], [data-wmb-detail]';

  /** Is it an assistant element (not the user's, not the form's, not a writing block) with a real MCP call? */
  function isCallElement(el) {
    const raw = el.textContent || '';
    return raw.includes('mcp_call') && !raw.includes('<server>')
      && !el.closest(OWN_NODES) // hide.js's line/detail holds the call's JSON: it is not a new call
      && !el.closest(USER_SEL) && !el.querySelector(USER_SEL) && !el.closest('form')
      // A result the extension wrote is data: a call inside it is never a new request.
      && !WMB.isBridgeMessage?.(raw)
      && !el.closest('aside, [data-testid*="canvas"], [data-testid*="document-editor"], [data-testid*="artifact"], .canvas-editor, .canvas-container, [class*="canvas"]');
  }

  const inDocumentOrder = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

  class ChatGPTAdapter extends WMB.BaseAdapter {
    #cache = null;

    constructor() {
      super({
        id: 'chatgpt',
        name: 'ChatGPT',
        selectors: {
          composer: [
            '#prompt-textarea',
            'div#prompt-textarea',
            'textarea#prompt-textarea',
            'div.ProseMirror[contenteditable="true"]',
            'div[contenteditable="true"][role="textbox"]',
            'textarea[name="prompt-textarea"]',
            'textarea[data-id="root"]',
            'textarea',
          ],
          sendButton: [
            'button[data-testid="send-button"]',
            'button[data-testid*="send" i]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="ارسال" i]',
            'button[aria-label*="Enviar" i]',
            'form button[type="submit"]',
          ],
          // ALL of them that return elements are used (not just the first).
          assistantMessages: [
            '[data-message-author-role="assistant"]',
            'article[data-turn="assistant"]',
            '[data-turn="assistant"]',
            'div.agent-turn',
          ],
          // The user's own turns: hide.js reads this list so the two can never drift apart.
          userMessages: USER_SEL.split(', '),
          // Only the "stop generating" button (not the dictation one).
          stopButton: [
            'button[data-testid="stop-button"]',
            'button[data-testid*="stop" i]',
            'button[aria-label*="Stop" i]',
            'button[aria-label*="توقف" i]',
            'button[aria-label*="Detener la transm" i]',
            'button[aria-label*="Detener generaci" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
      this.blocksAtDelivery = 0;
      this.turnStartEls = null;   // call blocks that already existed when the current turn began
    }

    markActivity(options) {
      super.markActivity(options);
      this.turnStartEls = new Set(this.#callElements());
      this.baselineUntil = 0;
    }

    /** Which conversation the page shows: the id of the URL, or the root path while the chat has none yet. */
    conversationKey() {
      const match = typeof location !== 'undefined' && (location.pathname.match(/\/c\/([^/?#]+)/) || [])[1];
      return match ? `/c/${match}` : (typeof location !== 'undefined' ? location.pathname : '/');
    }

    isNewChatPath(path) {
      return !/\/c\/[^/?#]+/.test(String(path ?? ''));
    }

    onDelivery() {
      this.blocksAtDelivery = this.#callElements().length;
      this.baselineUntil = 0;
    }

    isStreaming() {
      return super.isStreaming()
        || Boolean(typeof document !== 'undefined' && document.querySelector?.('.result-streaming, [data-is-streaming="true"], [class*="streaming"]'));
    }

    /**
     * Checks if an element belongs to a Writing Block (Canvas, Artifact, document editor) rather than the chat composer.
     */
    isWritingBlock(el) {
      return WMB.isWritingBlock ? WMB.isWritingBlock(el) : false;
    }

    /**
     * Finds the MAIN chat composer, strictly distinguishing it from any Writing Block / Canvas / Artifact editor.
     * The true chat textbox is ALWAYS associated with the chat submission form and send button.
     * If the main chat composer is not found, returns null immediately to prevent modifying Writing Blocks.
     */
    getComposer() {
      if (typeof document === 'undefined') return null;

      // 1. Direct and fastest check: #prompt-textarea
      const promptEl = document.getElementById('prompt-textarea');
      if (promptEl && !this.isWritingBlock(promptEl) && WMB.isVisible(promptEl)) {
        return promptEl;
      }

      // 2. Primary path: look inside the active chat form (the form containing send button or prompt-textarea)
      const forms = Array.from(document.querySelectorAll('form'));
      const chatForm = forms.find((f) => !this.isWritingBlock(f) && (f.querySelector('#prompt-textarea') || f.querySelector(this.selectors.sendButton.join(','))))
        ?? forms.find((f) => !this.isWritingBlock(f));

      if (chatForm) {
        for (const selector of this.selectors.composer) {
          try {
            const el = chatForm.querySelector(selector);
            if (el && !this.isWritingBlock(el) && WMB.isVisible(el)) {
              return el;
            }
          } catch { /* ignore */ }
        }
      }

      // 3. Fallback: only match within a form, strictly rejecting any writing block
      for (const selector of this.selectors.composer) {
        try {
          for (const el of document.querySelectorAll(`form ${selector}`)) {
            if (WMB.isVisible(el) && !this.isWritingBlock(el)) {
              return el;
            }
          }
        } catch { /* ignore */ }
      }

      // Under NO circumstances do we search document-wide for arbitrary contenteditable/ProseMirror elements,
      // because that would risk selecting the Writing Block (Canvas/Artifacts).
      return null;
    }

    matches(hostname) {
      return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') || hostname === 'chat.openai.com';
    }

    /**
     * Assistant messages in document order, without nesting (the outermost container wins), with the
     * code-aware text (`extractText` via the wrapped `textContent`). Includes the blocks/texts with
     * `mcp_call` that fall outside the known containers.
     */
    getAssistantMessages() {
      const now = Date.now();
      if (this.#cache && now - this.#cache.time < CACHE_MS) return this.#cache.list;

      const containers = new Set();
      for (const selector of this.selectors.assistantMessages) {
        try { document.querySelectorAll(selector).forEach((el) => containers.add(el)); } catch { /* invalid selector */ }
      }
      const known = [...containers].filter((el) => !el.closest(USER_SEL) && !el.querySelector(USER_SEL));
      const extras = this.#callElements().filter((el) => !known.some((c) => c.contains(el)));

      const all = [...known, ...extras];
      const list = all
        .filter((el) => !all.some((other) => other !== el && other.contains(el)))
        .sort(inDocumentOrder)
        .map(wrap);
      this.#cache = { time: now, list };
      return list;
    }

    /**
     * Watches the responses. Same interface as the base adapter:
     * `callback({id, call, element})` per new MCP call; `onDone({text, element})` per response without a call.
     * @returns {() => void} stops watching
     */
    observeResponses(callback, { onDone } = {}) {
      let alive = true;
      let scheduled = false;
      let lastDone = '';
      const done = new Map();       // already handled call id → {absentSince}
      const seen = new WeakMap();   // element → {text, since}
      const resumed = new Set();    // calls fired before this page load whose result never arrived
      const say = (message) => { try { this.debug?.('ok', `ChatGPT · ${message}`); } catch { /* no panel */ } };
      const convOf = () => (typeof location !== 'undefined' && (location.pathname.match(/\/c\/([^/?#]+)/) || [])[1])
        ? `/c/${location.pathname.match(/\/c\/([^/?#]+)/)[1]}`
        : (typeof location !== 'undefined' ? location.pathname : '/');
      let conv = convOf();
      this.restoreNewChatToken(); // a reload before the new chat got its URL still knows its token
      this.baselineUntil = Date.now() + BASELINE_MS;
      this.turnStartedAt = 0;
      this.turnStartEls = new Set(this.#callElements());

      /**
       * Is this call block part of a turn that started in this page session?
       * A restored conversation, an opened chat and a switched chat never start one: their calls are history.
       * EVERY block that appeared after the turn began is live — a single reply may carry several calls.
       */
      const isLiveTurn = (blocks, streaming) => {
        if (streaming) {
          // Generation in this page session IS a live turn, even without a trusted send event. Blocks already on
          // the page are history; the one being written stays live and so does everything after it.
          if (!this.turnStartedAt) {
            this.turnStartedAt = Date.now();
            this.armNewChatToken(); // generation without a trusted send event still identifies its chat
            this.turnStartEls = new Set(blocks.slice(0, Math.max(0, blocks.length - 1)));
          }
          return true;
        }
        return Boolean(this.turnStartedAt);
      };

      /** A call block is live when it was not on the page when the current turn began. */
      const isLiveBlockEl = (el) => !this.turnStartEls || !this.turnStartEls.has(el);

      const scan = () => {
        const now = Date.now();
        const streaming = this.isStreaming();
        const assistantMessages = this.getAssistantMessages();
        this.lastAssistantCount = Math.max(this.lastAssistantCount, assistantMessages.length);
        this.trackStagedDelivery(assistantMessages, streaming);
        const blocks = this.#callElements().sort(inDocumentOrder);

        // Conversation change (to another or to a "new chat"): start from scratch. A new chat that gets its URL
        // (/ → /c/<id>) does NOT count as a change.
        const nowConv = convOf();
        if (nowConv !== conv) {
          const previous = conv;
          conv = nowConv;
          // A NEW chat receives /c/<id> once its first reply starts: the SAME conversation. Its ledger moves
          // along and the turn stays armed — otherwise that very reply's call could never fire. The test is the
          // number of MESSAGES, never the number of call blocks: a first reply with 3+ calls used to be taken
          // for a real navigation and all its results were lost.
          const connected = Boolean(this.liveThreadEl && typeof document !== 'undefined' && document.contains(this.liveThreadEl));
          const sameThread = connected || this.sameLiveThread(assistantMessages);
          if (this.turnStartedAt && this.isNewChatPath(previous) && this.#knownTurns() <= 2 && sameThread) {
            const from = this.newChatToken && this.isNewChatPath(previous) ? this.newChatToken : previous;
            this.adoptConversation(from, nowConv);
            this.liveThreadEl = null;
            this.liveReplySig = null;
          } else {
            done.clear();
            this.lastActivity = 0;
            lastDone = '';
            this.baselineUntil = Date.now() + BASELINE_MS;
            this.genSinceDelivery = false;
            this.lastDeliveryAt = 0;
            this.newChatToken = null; // a real navigation: the old new-chat token must never match again
            this.liveThreadEl = null;
            this.liveReplySig = null;
            this.liveReplyCount = 0;
            this.liveUserSig = null;
            this.turnStartedAt = 0;
            this.turnStartEls = new Set(blocks);
          }
        }

        if (streaming) {
          this.lastActivity = now;
          this.baselineUntil = 0;
        }
        if (this.lastDeliveryAt && (streaming || blocks.length > (this.blocksAtDelivery || 0))) {
          this.genSinceDelivery = true;
        }
        const baseline = now < this.baselineUntil;

        const userNodes = Array.from(document.querySelectorAll(USER_SEL));
        const lastUser = userNodes.length ? userNodes[userNodes.length - 1] : null;

        const tally = new Map();
        const present = new Set();
        // A call block is live when it did not exist before the current turn began. A single reply may carry
        // SEVERAL call blocks, and all of them are live (only the last one used to be, so A and B were dropped).
        const liveTurn = isLiveTurn(blocks, streaming);
        // The block this turn is about: a URL adoption needs it to still be in the DOM (the same thread) or,
        // after a same-chat re-render, the same reply content + user turn.
        if (blocks.length && (streaming || this.turnStartedAt)) {
          this.liveThreadEl = blocks[blocks.length - 1];
          const lastMessage = assistantMessages[assistantMessages.length - 1];
          this.liveReplySig = lastMessage ? this.messageSignature(lastMessage) : null;
          this.liveReplyCount = assistantMessages.length;
          try {
            const users = this.getUserMessages();
            this.liveUserSig = users.length ? WMB.hash(users[users.length - 1].textContent || '') : null;
          } catch { this.liveUserSig = null; }
        }
        // Calls ready in this scan, collected across ALL blocks: one reply, one batch, one result message.
        const batchCalls = [];
        const batchIds = [];
        let batchEl = null;
        for (const el of blocks) {
          // If el appears physically before the latest user message, it has already been answered by that user message!
          // Therefore, it is part of a previous conversation turn and MUST NOT be executed.
          if (lastUser && (el.compareDocumentPosition(lastUser) & Node.DOCUMENT_POSITION_FOLLOWING)) {
            continue;
          }

          const text = extractText(el);
          let state = seen.get(el);
          if (!state || state.text !== text) {
            state = { text, since: now, executed: false };
            seen.set(el, state);
          }
          if (state.executed) continue; // An already executed element must NEVER be re-executed
          const calls = WMB.extractMcpCalls(text);
          if (!calls.length) continue;
          const stableFor = now - state.since;
          const ready = baseline || (stableFor >= STABLE_MS && (!streaming || stableFor >= STUCK_MS));

          let fire = false;
          const ids = [];
          const liveBlock = liveTurn && isLiveBlockEl(el);
          calls.forEach((call, n) => {
            // ID = the call + how many identical ones come before it on the page (depends on neither URL nor message IDs).
            const hash = WMB.hash(JSON.stringify(call));
            const occurrence = tally.get(hash) ?? 0;
            tally.set(hash, occurrence + 1);
            const id = `${hash}:${occurrence}`;
            present.add(id);
            if (!ready) return;
            // Fired in THIS conversation but its result never arrived (a reload mid-run): the AI is waiting, so it
            // runs once on this page load. A precise, persisted signal — it needs no live turn.
            const pending = this.isPending(id) && !resumed.has(id);
            // A pending call whose history was already on the page when this load began (a reload right after
            // the tool ran): do NOT index it as history during the baseline. Baseline marks blocks as seen,
            // which would leave the pending call permanently unsent; after the window it fires once.
            if (baseline && pending) return;
            // A block that is not the last one of a live turn is history: remembered as seen, never fired.
            if (!liveBlock && !pending) {
              if (!done.has(id)) done.set(id, { absentSince: 0 });
              state.executed = true;
              return;
            }
            // Fired in this TAB before this page loaded AND its result already reached the chat: history.
            if (!done.has(id) && this.hasExecuted(id) && this.hasDelivered(id)) {
              done.set(id, { absentSince: 0 });
              state.executed = true;
              return;
            }
            let fireId = id;
            if (done.has(id) && !pending) {
              // Call identical to one already run: it is only a real repeat (the AI awaits a reply again) if it replied after
              // receiving the result; otherwise it is a page repaint.
              if (baseline || streaming || n !== 0 || !this.genSinceDelivery) return;
              fireId = `${id}~r${this.deliveries}`;
              if (done.has(fireId)) return;
              present.add(fireId);
            }
            // ANY id fired in this page load is resumed: a re-render in the same page must never re-run a
            // call whose delivery failed (only a real reload may retry it).
            resumed.add(id);
            done.set(fireId, { absentSince: 0 });
            state.executed = true; // Mark element executed so it will never re-fire itself
            ids.push(fireId);
            if (n === 0) fire = true;
          });
          // In baseline it is only memorised for THIS page load: nothing is persisted, so a restored chat can
          // never look like a pending request on the next load.
          if (fire && !baseline) {
            ids.forEach((fireId) => { if (!fireId.includes('~r')) this.rememberExecuted(fireId); });
            // Collected, not fired here: all blocks of this reply travel in ONE detection, so the controller runs
            // them sequentially and writes ONE message with every result (it used to send only the last block).
            batchCalls.push(...calls);
            batchIds.push(...ids);
            batchEl = batchEl ?? el;
          }
        }
        if (batchCalls.length) {
          say('call detected, running…');
          this.liveThreadEl = batchEl;
          this.persistNewChatToken(); // the thread signature a reload needs to find this pending call
          // A readable call next to an unreadable one: the readable ones run and the broken block is reported
          // (the parser used to return as soon as one call was read, swallowing the broken sibling).
          const badText = !streaming && WMB.malformedCallBlocks
            ? (WMB.malformedCallBlocks(blocks.map((el) => extractText(el)).join('\n'))[0] ?? null) : null;
          callback({ id: batchIds[0], call: batchCalls[0], calls: batchCalls, ids: batchIds, element: wrap(batchEl), extra: 0, conversation: this.conversationIdentity(), turn: this.turnStartedAt, badText });
        } else if (!baseline && !streaming && this.turnStartedAt && WMB.looksMalformed) {
          // ChatGPT used to ignore an unreadable block entirely (its own observer never called looksMalformed):
          // the AI waited forever. The exact reason is sent back like on every other platform.
          const messages = this.getAssistantMessages();
          let last = -1;
          for (let i = messages.length - 1; i >= 0 && last < 0; i -= 1) if ((messages[i].textContent || '').trim()) last = i;
          const text = last >= 0 ? messages[last].textContent : '';
          if (text && !WMB.extractMcpCalls(text).length && WMB.looksMalformed(text)) {
            const badId = `${conv}#bad:${WMB.hash(text)}`;
            if (!this.hasExecuted(badId)) {
              this.rememberExecuted(badId);
              callback({ id: badId, malformed: true, text, element: messages[last], conversation: this.conversationIdentity(), turn: this.turnStartedAt });
            }
          }
        }

        // Calls no longer on the page are forgotten (so repeating a task never stays blocked).
        for (const [id, entry] of done) {
          if (present.has(id)) entry.absentSince = 0;
          else if (!entry.absentSince) entry.absentSince = now;
          else if (now - entry.absentSince >= FORGET_MS) done.delete(id);
        }

        // Finished response WITHOUT an MCP call.
        if (!baseline && !streaming && onDone) {
          const messages = this.getAssistantMessages();
          let last = -1;
          for (let i = messages.length - 1; i >= 0 && last < 0; i -= 1) if ((messages[i].textContent || '').trim()) last = i;
          if (last >= 0) {
            const text = messages[last].textContent;
            const key = `${conv}:${messages.length}:${text.length}`;
            const probe = seen.get(messages[last].__raw) ?? { text: '', since: now };
            if (probe.text !== text) seen.set(messages[last].__raw, { text, since: now });
            else if (now - probe.since >= STABLE_MS && key !== lastDone && !WMB.extractMcpCalls(text).length) {
              lastDone = key; onDone({ text, element: messages[last] });
            }
          }
        }
      };
      this.rescan = () => { lastDone = ''; scan(); };

      const schedule = (delay = 400) => {
        if (scheduled) return;
        scheduled = true;
        WMB.sleep(delay).then(() => { scheduled = false; if (alive) scan(); });
      };
      const observer = new MutationObserver(() => schedule());
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      const wake = () => { if (!document.hidden) this.rescan(); };
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('focus', wake);

      (async () => {
        while (alive) {
          await WMB.sleep(POLL_MS);
          if (!WMB.extensionAlive()) alive = false;
          if (!alive) break;
          scan();
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
     * Assistant TURNS by the declared containers (not the extra blocks found by text): a first reply that
     * carries three separate call blocks is still ONE turn, while an opened old chat has many.
     */
    #knownTurns() {
      const containers = new Set();
      for (const selector of this.selectors.assistantMessages) {
        try { document.querySelectorAll(selector).forEach((el) => containers.add(el)); } catch { /* invalid selector */ }
      }
      const known = [...containers].filter((el) => !el.closest(USER_SEL) && !el.querySelector(USER_SEL));
      return known.filter((el) => !known.some((other) => other !== el && other.contains(el))).length;
    }

    /** Elements with an MCP call located by their text: <pre> blocks and, failing that, normal text. */
    #callElements() {
      const found = Array.from(document.querySelectorAll('pre')).filter(isCallElement);

      // Normal text: the text node with "mcp_call" is looked up and the walk goes up to the element whose text contains a valid call.
      // SCRIPT/STYLE/NOSCRIPT/SVG text is rejected in the filter itself: on heavy pages those subtrees are a
      // large share of the text nodes, and no call can ever live in them.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          return parent && SKIP_TAGS.has(parent.tagName.toUpperCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!/mcp_call|"server"\s*:/.test(node.nodeValue) || node.nodeValue.includes('<server>')) continue;
        let el = node.parentElement;
        if (!el || el.closest(OWN_NODES) || el.closest(USER_SEL) || el.closest('form') || el.closest('[contenteditable="true"]')) continue;
        for (let depth = 0; el && depth < 10 && el !== document.body && el.tagName !== 'MAIN'; depth += 1, el = el.parentElement) {
          if (el.querySelector(USER_SEL)) break;
          if (!isCallElement(el)) continue;
          if (WMB.extractMcpCalls(extractText(el)).length) {
            if (!found.some((f) => f === el || f.contains(el))) found.push(el);
            break;
          }
        }
      }
      // Keep only the OUTERMOST match: a block that contains another found block already carries its text.
      // (The old exemption for `pre` kept both a container and the code block inside it, so one call in the
      // container was extracted twice under two different occurrence ids and answered twice.)
      return found.filter((el) => !found.some((other) => other !== el && other.contains(el)));
    }
  }

  WMB.registerAdapter(new ChatGPTAdapter());
})();