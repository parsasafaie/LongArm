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
  const STABLE_MS = 1200;     // the block must stay unchanged this long
  const STUCK_MS = 2500;      // "generating" stuck: taken as finished after this stable time
  const POLL_MS = 700;
  const ACTIVE_MS = 180_000;  // a call is only "new" if there was activity less than this long ago
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

  /** Is it an assistant element (not the user's, not the form's) with a real MCP call (not the prompt template)? */
  function isCallElement(el) {
    const raw = el.textContent || '';
    return raw.includes('mcp_call') && !raw.includes('<server>')
      && !el.closest(USER_SEL) && !el.querySelector(USER_SEL) && !el.closest('form');
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
            'div.ProseMirror[contenteditable="true"]',
            'form div[contenteditable="true"]',
            'textarea[name="prompt-textarea"]',
            'textarea[data-id="root"]',
            'form textarea',
          ],
          sendButton: [
            'button[data-testid="send-button"]',
            'button[aria-label*="Send" i]',
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
            'button[aria-label*="Stop streaming" i]',
            'button[aria-label*="Stop generating" i]',
            'button[aria-label*="Detener la transm" i]',
            'button[aria-label*="Detener generaci" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
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
      const say = (message) => { try { this.debug?.('ok', `ChatGPT · ${message}`); } catch { /* no panel */ } };
      const convOf = () => (location.pathname.match(/\/c\/([^/?#]+)/) || [])[1] || null;
      let conv = convOf();

      const scan = () => {
        const now = Date.now();

        // Conversation change (to another or to a "new chat"): start from scratch. A new chat that gets its URL
        // (/ → /c/<id>) does NOT count as a change.
        const nowConv = convOf();
        if (nowConv !== conv) {
          if (conv !== null) { done.clear(); this.lastActivity = 0; lastDone = ''; }
          conv = nowConv;
        }

        const streaming = this.isStreaming();
        if (streaming) this.lastActivity = now;
        if (streaming && this.lastDeliveryAt) this.genSinceDelivery = true;
        const baseline = now - this.lastActivity >= ACTIVE_MS;

        const tally = new Map();
        const present = new Set();
        const blocks = this.#callElements().sort(inDocumentOrder);
        for (const el of blocks) {
          const text = extractText(el);
          let state = seen.get(el);
          if (!state || state.text !== text) { state = { text, since: now }; seen.set(el, state); }
          const calls = WMB.extractMcpCalls(text);
          if (!calls.length) continue;
          const stableFor = now - state.since;
          const ready = baseline || (stableFor >= STABLE_MS && (!streaming || stableFor >= STUCK_MS));

          calls.forEach((call, n) => {
            // ID = the call + how many identical ones come before it on the page (depends on neither URL nor message IDs).
            const hash = WMB.hash(JSON.stringify(call));
            const occurrence = tally.get(hash) ?? 0;
            tally.set(hash, occurrence + 1);
            const id = `${hash}:${occurrence}`;
            present.add(id);
            if (!ready) return;
            let fireId = id;
            if (done.has(id)) {
              // Call identical to one already run: it is only a real repeat (the AI awaits a reply again) if it replied after
              // receiving the result and this is its last block; otherwise it is a page repaint.
              if (baseline || streaming || n !== 0 || el !== blocks[blocks.length - 1] || !this.genSinceDelivery) return;
              fireId = `${id}~r${this.deliveries}`;
              if (done.has(fireId)) return;
              present.add(fireId);
            }
            done.set(fireId, { absentSince: 0 });
            // Protocol: one call per message → only the first runs. In baseline it is only memorised.
            if (!baseline && n === 0) { say('call detected, running…'); callback({ id: fireId, call, element: wrap(el) }); }
          });
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
        if (!el || el.closest(USER_SEL) || el.closest('form') || el.closest('[contenteditable="true"]')) continue;
        for (let depth = 0; el && depth < 10 && el !== document.body && el.tagName !== 'MAIN'; depth += 1, el = el.parentElement) {
          if (el.querySelector(USER_SEL)) break;
          if (!isCallElement(el)) continue;
          if (WMB.extractMcpCalls(extractText(el)).length) {
            if (!found.some((f) => f === el || f.contains(el))) found.push(el);
            break;
          }
        }
      }
      return found.filter((el) => !found.some((other) => other !== el && el.contains(other) && !other.matches('pre')));
    }
  }

  WMB.registerAdapter(new ChatGPTAdapter());
})();