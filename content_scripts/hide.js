/**
 * hide.js — Keeps the bridge's own text out of the chat page (on by default).
 *
 * Two kinds of message carry it:
 *
 *   · RESULT      — `[MCP_RESULT …] … [/MCP_RESULT]`: every tool result, the tool list the AI asked for, and the
 *                   notices about a wrong name or an unreadable call. This is the one written all the time;
 *                   nothing else is ever sent into a conversation.
 *   · CALL        — `{"mcp_call": …}` as the whole reply of the AI. It is the AI's own message, so it is only
 *                   ever touched when it is nothing but the call (which is what the protocol asks it to send).
 *
 * Nothing is deleted: a message that is nothing but generated text is hidden as a whole (its text stays in the
 * DOM, and in `textContent`), and a part of a message is wrapped in a hidden <span>. The AI keeps whatever it
 * received, and turning the option off puts every message back exactly as it was.
 *
 * Matching is deliberately tolerant: whitespace is collapsed, quotes may come back as typographic ones, and the
 * text may be split over several elements. Nothing is matched by a site selector, so a chat that changes its
 * markup needs no new code.
 *
 * The module starts ENABLED: the setting only has to turn it off. Hiding must not depend on the extension
 * answering a state query — if that call fails, a page would silently keep showing the protocol.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB) return;
  // The page may already run an instance (the scripts are reinjected when the extension is reloaded, but the
  // old copy keeps its observer): a second one would only scan twice for the same result.
  if (WMB.hide) return;

  const MESSAGE_ATTR = 'data-wmb-hide-message';   // a message that is hidden whole
  const HIDDEN_ATTR = 'data-wmb-hidden';          // the <span> that hides one part of a message
  const DISPLAY_ATTR = 'data-wmb-display';        // the inline display the site had, to put it back
  const HOST_ID = 'wmb-host';                     // the floating panel (its text is never touched)

  /**
   * The words the extension wrote. All matching happens on the whitespace-collapsed text, so a chat
   * that turns line breaks into spaces still matches; quotes are compared loosely, because a renderer may
   * turn them into typographic ones.
   */
  const RESULT_START = /^\[\s*MCP_RESULT\b/i;                                            // a message of the bridge
  const RESULT_END = /\[\s*\/\s*MCP_RESULT\s*\]/i;
  /** Some sites prepend a tiny label to the user's own text ("You said ") before rendering it. */
  const PREFIXED_RESULT_START = /^[\s\S]{0,32}\[\s*MCP_RESULT\b/i;
  const RESULT_AT_END = /\[\s*\/\s*MCP_RESULT\s*\]\s*$/i;

  /**
   * The AI's own message (fallback list) and the user's own message: the text of neither is touched except for
   * the AI's pure `mcp_call` (see findTarget). A site's adapter declares its own `assistantMessages` and
   * `userMessages`, and `refreshSelectors()` reads them before each pass, so the cleanup and the call detection
   * cannot drift apart when a site renames its markup (exactly what happened with Claude's `.font-claude-message`).
   * These two lists are what is used when no adapter matches the host.
   */
  const ASSISTANT_FALLBACK = [
    '[data-message-author-role="assistant"]',
    '[data-turn="assistant"]',
    '.agent-turn',
    '.font-claude-response',
    '.font-claude-message',
    '[data-testid="assistant-message"]',
    'model-response',
    '.model-response-text',
    '.ds-markdown',
    'div[data-is-streaming]',
  ];
  const USER_FALLBACK = [
    '[data-message-author-role="user"]',
    '[data-turn="user"]',
    '[data-testid="user-message"]',
    '.font-user-message',
    'user-query',
  ];
  let ASSISTANT_SEL = ASSISTANT_FALLBACK.join(',');
  let USER_SEL = USER_FALLBACK.join(',');

  /**
   * The site's own selectors plus the fallbacks, resolved again before every pass: the adapters are the source of
   * truth for the sites they know (the extension needs them anyway to read the page), so a selector added there
   * reaches the cleanup too. The adapters load after this script, which is why this runs at scan time, not at
   * load — and why the fallbacks exist at all (the very first pass may run before they are registered).
   */
  function refreshSelectors() {
    const selectors = globalThis.WMB?.findAdapter?.(location.hostname)?.selectors ?? {};
    const withFallback = (fromAdapter, fallback) => [...new Set([...(fromAdapter ?? []), ...fallback])].join(',');
    ASSISTANT_SEL = withFallback(selectors.assistantMessages, ASSISTANT_FALLBACK);
    USER_SEL = withFallback(selectors.userMessages, USER_FALLBACK);
  }

  /** The composer: a draft is never touched, whatever it holds. */
  const COMPOSER_SEL = 'form, textarea, [contenteditable="true"], [role="textbox"]';
  /** The editable itself — the draft protection that must NEVER be waived. */
  const EDITABLE_SEL = 'textarea, [contenteditable="true"], [role="textbox"]';

  /**
   * A whole message (either role): the outermost element that is still this message and nothing else. It is
   * where hiding stops — the avatar and the buttons of the turn go with it, and the layout container (which also
   * holds other messages, or the text box) never does.
   */
  const MESSAGE_SEL = [
    '[data-message-author-role]',
    '[data-turn]',
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    'user-query',
    'model-response',
    '.font-user-message',
    '.font-claude-message',
    '.ds-message',
  ].join(',');

  /** Layout containers: never hidden, whatever the text inside them happens to be. */
  const NEVER_HIDE_SEL = 'main, [role="main"], [role="log"], [role="feed"], [role="list"], #root, #app, #__next';

  /** What makes text a message instead of small print: a paragraph, a list, a table, a code block. A caption,
   *  a label or a button word never is one, and that difference is what tells a message from a block inside it. */
  const CONTENT_SEL = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, table, pre';

  const COLLAPSE = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  /** A pure call is a short message; past this size an element can never be one (the climb inside the AI's own
   *  message stops there, so no full-message text is ever built just to look for a call). */
  const MAX_CALL_CHARS = 8000;

  /**
   * What of a message the extension wrote and the page must not show, as `[start, end)` ranges of the
   * whitespace-collapsed text. Pure, so it can be tested without a page. A result message hides WHOLE:
   * the note ("only the first call was run…") rides after its closing tag, and it is the extension's too.
   * @param {string} text
   * @returns {{start:number,end:number,kind:'result'}[]}
   */
  function planHiddenRanges(text) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (RESULT_START.test(flat) && RESULT_END.test(flat)) {
      return [{ start: 0, end: flat.length, kind: 'result' }];
    }
    return [];
  }

  /** The text that stays visible when those ranges are taken out. */
  function remainingText(flat, ranges) {
    let out = '';
    let at = 0;
    for (const range of ranges) {
      out += flat.slice(at, range.start);
      at = Math.max(at, range.end);
    }
    return out + flat.slice(at);
  }

  /**
   * Is this a message that is nothing but the extension's own text? Pure: the tests use it, and the page uses it
   * to decide between hiding the whole message and hiding a part of it.
   */
  function isBridgeMessage(text) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    const ranges = planHiddenRanges(flat);
    if (ranges.length > 0 && !remainingText(flat, ranges).trim()) return true;
    // Gemini renders a result as `You said [MCP_RESULT …]…`: still the extension's own message. The adapters
    // use this to refuse to read a call out of a result (a result is data, never a new request).
    return PREFIXED_RESULT_START.test(flat) && RESULT_END.test(flat);
  }

  // ───────────────────────── The AI's own call ─────────────────────────
  // The ONE thing of the AI's own message that is hidden: a reply that is nothing but one `mcp_call`, which is
  // exactly what the protocol asks it to send. Reading it is pure, so it is tested without a page.

  /**
   * An echo of the format — `<server>`, `<tool>`, «arg», `…` — is not a call: the frame the instructions spell
   * out must never be mistaken for one (a chat where the AI shows the format keeps its message).
   */
  const FRAME_VALUE = /^(?:[.\u2026]+|[<«][^>»]*[>»])$/;
  const isFrameValue = (value) => FRAME_VALUE.test(String(value ?? '').trim());

  /** The caption a rendered code block may carry around the code (`JSON`, `Copy code`): it is not part of it. */
  const EDGE_CHROME = /^(?:copy(?: code)?|code|json)\s*|\s*(?:copy(?: code)?|code|json)$/gi;

  /**
   * Is this text NOTHING but one or more `mcp_call` objects? A fence around it is tolerated (that is how the protocol asks
   * for it), and so is the caption a rendered code block may carry around it (`JSON`, `Copy code`). Anything else
   * — prose, a quote of the format, an echo of the frame — is not a call.
   */
  function isPureCall(text) {
    const bare = String(text ?? '').trim()
      .replace(/^```[a-z0-9_-]*\s*/i, '').replace(/\s*```$/, '')
      .replace(EDGE_CHROME, '')
      .trim();
    if (!bare.includes('mcp_call')) return false;

    // Single JSON object
    if (bare.startsWith('{') && bare.endsWith('}')) {
      let parsed;
      for (const candidate of [bare, bare.replace(/[\u201c\u201d\u201e\u2033]/g, '"')]) {
        try { parsed = JSON.parse(candidate); break; } catch { /* try the next form */ }
      }
      const call = parsed?.mcp_call;
      if (call && typeof call.name === 'string' && call.name) {
        return !isFrameValue(call.name) && !isFrameValue(call.server);
      }
    }

    // Array of calls: [ {"mcp_call": ...}, ... ]
    if (bare.startsWith('[') && bare.endsWith(']')) {
      let parsed;
      for (const candidate of [bare, bare.replace(/[\u201c\u201d\u201e\u2033]/g, '"')]) {
        try { parsed = JSON.parse(candidate); break; } catch { /* try next */ }
      }
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.every((item) => {
          const call = item?.mcp_call;
          return call && typeof call.name === 'string' && call.name && !isFrameValue(call.name) && !isFrameValue(call.server);
        });
      }
    }

    // Multiple JSON call objects (e.g. newline-delimited JSON objects where each line is a pure call)
    const lines = bare.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2 && lines.every((l) => isPureCall(l))) {
      return true;
    }

    return false;
  }

  // ───────────────────────── DOM ─────────────────────────

  /**
   * The text of an element's text nodes, collapsed to single spaces, plus the way back to the DOM: `map[i]` is
   * the raw offset of the character that produced the i-th collapsed character, and `nodes` lists the text nodes
   * with their raw ranges. A chat may render every line as its own paragraph; matching on the collapsed text is
   * what makes the block recognisable either way.
   */
  function textIndex(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let raw = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue ?? '';
      if (!value) continue;
      nodes.push({ node, start: raw.length, end: raw.length + value.length });
      raw += value;
    }

    let text = '';
    const map = [];
    let space = false; // a whitespace run is waiting to become one space
    for (let i = 0; i < raw.length; i += 1) {
      if (/\s/.test(raw[i])) {
        if (text) space = true;
        continue;
      }
      if (space) { text += ' '; map.push(i); space = false; }
      text += raw[i];
      map.push(i);
    }
    return { text, map, nodes, raw };
  }

  /** The text node and offset of a raw offset. */
  function locate(index, offset) {
    for (const entry of index.nodes) {
      if (offset < entry.end) return { node: entry.node, offset: offset - entry.start };
    }
    const last = index.nodes[index.nodes.length - 1];
    return last ? { node: last.node, offset: last.node.nodeValue.length } : null;
  }

  /** A collapsed range as a raw one, with the whitespace around it taken along (no blank line is left). */
  function toRawRange(index, range) {
    let start = index.map[range.start] ?? index.raw.length;
    let end = range.end < index.map.length ? index.map[range.end] : index.raw.length;
    while (start > 0 && /\s/.test(index.raw[start - 1])) start -= 1;
    while (end < index.raw.length && /\s/.test(index.raw[end])) end += 1;
    return { start, end };
  }

  /** Wraps one raw range in a hidden <span>, keeping its text in the DOM. */
  function wrapRange(index, range) {
    const from = locate(index, range.start);
    const to = locate(index, range.end);
    if (!from || !to) return;
    const dom = document.createRange();
    try {
      dom.setStart(from.node, from.offset);
      dom.setEnd(to.node, to.offset);
    } catch { return; }

    const span = document.createElement('span');
    span.setAttribute(HIDDEN_ATTR, '1');
    span.style.display = 'none';
    try {
      dom.surroundContents(span);
    } catch {
      // The range crosses elements (a chat that splits the text into paragraphs): move it in instead.
      try {
        span.append(dom.extractContents());
        dom.insertNode(span);
      } catch { /* the DOM changed under us: the next scan retries */ }
    }
  }

  /** The small print a bubble may carry around the message (a label, a button caption): it may ride along. */
  const CHROME_CHARS = 60;

  /** Does this element hold text of its own that is content — a paragraph — rather than small print? */
  function addsContent(parent, target) {
    for (const el of parent.querySelectorAll(CONTENT_SEL)) {
      if (!el.contains(target) && !target.contains(el)) return true;
    }
    return false;
  }

  /** Is this element the whole message (a caption aside), or only a block of it, with prose around it? */
  function isWholeMessage(holder, el) {
    const all = COLLAPSE(holder.textContent);
    const own = COLLAPSE(el.textContent);
    if (!own || !all.includes(own)) return false;
    return all.split(own).join('').length <= CHROME_CHARS && !addsContent(holder, el);
  }

  /** Does this element hold a message OTHER than the one being hidden? Then it is not ours to hide. */
  function holdsAnotherMessage(parent, target) {
    for (const el of parent.querySelectorAll(`${MESSAGE_SEL},${ASSISTANT_SEL}`)) {
      if (el !== target && !el.contains(target) && !target.contains(el)) return true;
    }
    return false;
  }

  /**
   * Climbs to the turn that holds this message alone. Entered: wrappers that carry this message and nothing else,
   * plus the few characters of small print a bubble may add (a "You said:" label, a button caption, a code-block
   * header) — because the element the text was found in is NOT where hiding stops: the bubble and its box usually
   * sit above it, and stopping there would leave an empty bubble on screen.
   * `whole` = the element carries the whole message. When it is only a block inside a longer reply (prose around
   * the call), the climb stops at that block: a wrapper that adds a paragraph is the message itself, and the
   * message is not ours to hide.
   */
  function messageElement(el, whole = true) {
    let target = el;
    let own = COLLAPSE(target.textContent);
    let budget = CHROME_CHARS;
    for (let depth = 0; depth < 6 && own; depth += 1) {
      const parent = target.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (parent.id === HOST_ID || parent.querySelector(COMPOSER_SEL)) break;
      if (parent.matches(NEVER_HIDE_SEL)) break;
      if (holdsAnotherMessage(parent, target)) break;
      const all = COLLAPSE(parent.textContent);
      if (!all.includes(own)) break;
      budget -= all.split(own).join('').length; // everything the wrapper adds on top of the message
      if (budget < 0) break;
      if (!whole && addsContent(parent, target)) break;
      target = parent;
    }
    return target;
  }

  /** Hides a message that is nothing but generated text. Its text stays in the DOM. */
  function hideMessage(el, whole = true) {
    const target = messageElement(el, whole);
    if (target.hasAttribute(MESSAGE_ATTR)) return target;
    try { target.setAttribute(DISPLAY_ATTR, JSON.stringify({ value: target.style.getPropertyValue('display'), priority: target.style.getPropertyPriority('display') })); } catch { /* noop */ }
    target.setAttribute(MESSAGE_ATTR, '1');
    target.style.setProperty('display', 'none', 'important');
    return target;
  }

  // ───────────────────────── Applying the plan ─────────────────────────

  /** Applies the plan to one message: hide the whole thing, or wrap the parts the extension wrote. */
  function applyHidden({ el, index, ranges, call, whole }) {
    // A pure call has no partial plan: its whole text is generated and disappears like a result.
    if (call || !remainingText(index.text, ranges).trim()) {
      hideMessage(el, call ? whole !== false : true);
      return;
    }
    // From the end backwards: wrapping a range splits its text node, and the earlier offsets must stay valid.
    for (let i = ranges.length - 1; i >= 0; i -= 1) wrapRange(index, toRawRange(index, ranges[i]));
  }

  /**
   * The smallest element that holds a whole generated range, or null when the text is not in a message (the
   * composer, the panel, the AI's reply, or nothing the patterns recognise).
   * The AI's own message is never matched, with ONE exception: a message that is nothing but an `mcp_call`
   * (exactly what the protocol asks the AI to send) disappears like everything else.
   */
  /** Set when findTarget walked off the page without ever finding a hideable container for a result marker. */
  let climbExhausted = false;
  /** The panel (core_bridge) wires a reporter here; results that could not be hidden are told through it. */
  let onBlocked = null;
  let lastBlockedReport = 0;

  function findTarget(node) {
    let el = node.parentElement;
    climbExhausted = false;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.id === HOST_ID) return null;
      // The editable itself is never touched: a draft keeps whatever it holds. UNLESS the editable (or a
      // container with an editable in it) IS a message element — some sites render sent messages in
      // role=textbox containers, and those must hide like any other message.
      if (el.closest(EDITABLE_SEL) && !el.closest(`${MESSAGE_SEL}, ${ASSISTANT_SEL}, ${USER_SEL}`)) return null;
      // A bare <form> that wraps the conversation (some sites put the sent messages inside the composer's
      // form) must not grant draft protection to the messages in it — the editable above is the draft.
      if (el.closest('form') && !el.closest(`${MESSAGE_SEL}, ${ASSISTANT_SEL}, ${USER_SEL}`)) return null;
      const inAssistant = Boolean(el.closest(ASSISTANT_SEL));
      const inUser = Boolean(el.closest(USER_SEL));
      // The AI's own message is never touched — EXCEPT a pure call, the one thing the protocol asks it to send.
      // Recognising it needs the element whose text is nothing but the call, so the climb goes on inside the AI's
      // message: a call is short, and the climb ends as soon as the element is too big to be only a call (which
      // also keeps textIndex off the large elements of the conversation).
      if (inAssistant && (el.textContent ?? '').length > MAX_CALL_CHARS) return null;
      const index = textIndex(el);
      let ranges = planHiddenRanges(index.text);
      // Gemini (and sites like it) render the user's sent text with a tiny label in front ("You said "):
      // the message then does not START with the wrapper, but it is the user's own message, it ENDS with
      // the closing tag and carries nothing else — hide it whole, label and all. (Assistant messages stay
      // out: an AI reply quoting a result must remain on screen.)
      if (!ranges.length && inUser && PREFIXED_RESULT_START.test(index.text) && RESULT_AT_END.test(index.text)) {
        ranges = [{ start: 0, end: index.text.length, kind: 'result' }];
      }
      if (inAssistant && ranges.length) return null; // a result quoted in the AI's words: left alone, on purpose
      // A pure call disappears whether the assistant's markup is recognised or not — but never when the message
      // is the user's own (a call pasted into it is their text) and never when prose surrounds the call.
      const call = !inUser && isPureCall(index.text);
      if (ranges.length) return { el, index, ranges };
      if (call) {
        // A pure call carries no wrapper: this element's own text is the whole thing. Only a block of a longer
        // reply (prose around the call) has to stop where it is — the message itself is not ours to hide then.
        const holder = el.closest(MESSAGE_SEL) ?? el;
        return { el, index, ranges: [], call: true, whole: isWholeMessage(holder, el) };
      }
      el = el.parentElement;
    }
    climbExhausted = true; // no ancestor holds the full result text: the message cannot be hidden as it is
    return null;
  }

  // ───────────────────────── Scan ─────────────────────────

  /**
   * The markers every generated message carries — the result wrapper and the call — as one XPath
   * lookup. The word alone is enough for the call: a renderer may put typographic quotes around it, or split the
   * quoted key across several elements, and a text node that holds only `mcp_call` must still be found.
   */
  const XPATH = `//text()[contains(., 'MCP_RESULT') or contains(., 'mcp_call')]`;

  /** One pass over the page: every message that carries the bridge's own text is cleaned up. */
  function scan() {
    if (!enabled) return;
    refreshSelectors(); // the site's adapter (when there is one) contributes its own selectors to this pass
    let found;
    try { found = document.evaluate(XPATH, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); } catch { return; }
    for (let i = 0; i < found.snapshotLength; i += 1) {
      const node = found.snapshotItem(i);
      const parent = node?.parentElement;
      if (!parent || parent.closest(`[${HIDDEN_ATTR}], [${MESSAGE_ATTR}]`)) continue; // already hidden
      const target = findTarget(node);
      if (target) {
        try { applyHidden(target); } catch { /* the DOM changed under us: the next scan retries */ }
      } else if (climbExhausted && node.nodeValue.includes('MCP_RESULT')) {
        // A RESULT the scan could not hide: the user is looking at bridge text that should have vanished.
        // Reported at most once every 8 s, through the reporter core_bridge wires to the panel.
        if (Date.now() - lastBlockedReport >= 8000) {
          lastBlockedReport = Date.now();
          const sample = node.nodeValue.replace(/\s+/g, ' ').trim().slice(0, 90);
          try { onBlocked?.(`no element holding the full result was found — starts with: ${sample}`); } catch { /* no reporter */ }
        }
      }
    }
  }

  let enabled = true; // on by default: the setting only has to turn it OFF (see the header)
  let observer = null;
  let timer = null;
  let lastScan = 0;

  // At most one scan every 400 ms: a chat repaints a lot, and the pass is cheap but not free.
  function schedule() {
    if (!enabled || timer) return;
    const wait = Math.max(0, 400 - (Date.now() - lastScan));
    timer = setTimeout(() => { timer = null; lastScan = Date.now(); scan(); }, wait);
  }

  function start() {
    if (observer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    schedule();
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  /** Puts every hidden message and part back on screen: the chat is exactly what it was before. */
  function unhideAll() {
    for (const el of document.querySelectorAll(`[${MESSAGE_ATTR}]`)) {
      let saved = null;
      try { saved = JSON.parse(el.getAttribute(DISPLAY_ATTR) ?? 'null'); } catch { /* no saved value */ }
      if (saved?.value) el.style.setProperty('display', saved.value, saved.priority || undefined);
      else el.style.removeProperty('display');
      el.removeAttribute(MESSAGE_ATTR);
      el.removeAttribute(DISPLAY_ATTR);
    }
    for (const span of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
      const parent = span.parentNode;
      if (!parent) continue;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize?.(); // the two halves of a text node become one again
    }
  }

  /**
   * Turns the option on or off. Called by core_bridge with the setting, on every refresh.
   * Only an explicit `false` turns it off: a missing value (the first refresh before the extension answers, or an
   * older stored setting) must not leave the protocol on screen.
   * @param {unknown} value
   */
  function configure(value) {
    const on = value !== false;
    if (on === enabled) return;
    enabled = on;
    if (!enabled) {
      stop();
      unhideAll();
      return;
    }
    start();
    scan();
  }

  WMB.hide = {
    configure,
    scan,
    unhideAll,
    /** core_bridge wires its panel logger here: hide reports results it could not hide (at most one per 8 s). */
    set reporter(fn) { onBlocked = fn; },
  };
  WMB.planHiddenRanges = planHiddenRanges; // pure: the tests exercise them without a page
  WMB.isBridgeMessage = isBridgeMessage;
  WMB.isPureCall = isPureCall;             // pure: the AI's own call, the one message of it that is hidden
  /**
   * The decisions of the DOM path, for `tests/test_hide_dom.mjs` (which drives them on a fake tree): which
   * element a message is, where hiding lands, whether the found text is the whole message, and the plan applied.
   * The page itself only ever calls `WMB.hide`.
   */
  WMB.hideInternals = { findTarget, messageElement, hideMessage, isWholeMessage, applyHidden };

  if (typeof document !== 'undefined') {
    // Enabled from the start, before the extension has said anything: the protocol must never be on screen just
    // because a state query was slow or failed. The setting can only turn it off afterwards.
    start();
    scan();
    // A hidden tab is throttled; when it comes back, whatever arrived meanwhile is cleaned up at once.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scan(); });
    if (typeof window !== 'undefined') window.addEventListener('focus', () => scan());
  }
})();
