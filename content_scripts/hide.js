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
 * DOM, and in `textContent`), and a part of a message is wrapped in a hidden <span>. A hidden result leaves a
 * single short terminal-style line behind (`MCP · server › tool`, plus its status); a call leaves the same line
 * with `running` until its result replaces it. Each line carries its own detail — the result's text, or the
 * call's JSON — opened right under it. The AI keeps whatever it received, and turning the option off puts every
 * message back exactly as it was.
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
  const CHIP_ATTR = 'data-wmb-chip';              // the compact line that stands in for a hidden result
  const DETAIL_ATTR = 'data-wmb-detail';          // the raw call/result text one line opens
  const HOST_ID = 'wmb-host';                     // the floating panel (its text is never touched)

  /**
   * The words the extension wrote. All matching happens on the whitespace-collapsed text, so a chat
   * that turns line breaks into spaces still matches; quotes are compared loosely, because a renderer may
   * turn them into typographic ones.
   */
  const RESULT_START = /^\[\s*MCP_RESULT\b/i;                                            // a message of the bridge
  const RESULT_END = /\[\s*\/\s*MCP_RESULT\s*\]/i;
  /** One whole result block: the header attributes and the body between the wrapper tags (a batch has several). */
  const RESULT_BLOCK = /\[\s*MCP_RESULT\b([^\]]*)\]([\s\S]*?)\[\s*\/\s*MCP_RESULT\s*\]/gi;
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

  /**
   * A pure call used to be a short message; with batching (and long arguments, a file body) it can be large. Past
   * the prose bound, only call-shaped text is indexed; past the hard bound nothing is (the climb inside the AI's
   * own message stops there, so no huge reply is ever mapped just to look for a call).
   */
  const CALL_PROSE_CHARS = 8000;
  const MAX_CALL_CHARS = 131072;
  /** What a call message starts with: the JSON, behind a fence or the caption a code block renders. */
  const CALL_SHAPE = /^(?:json|code|copy code|copy)?\s*(?:```[a-z0-9_-]*\s*)?[{[]/i;

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
   * The small print that may sit BETWEEN the blocks of one message (a `JSON` header per code block, the action
   * labels). Stripped only when a whole message is checked; a call's own text is never touched.
   */
  const BETWEEN_CHROME = /```[a-z0-9_-]*|copy(?: code)?|code|json|retry|regenerate|edit/gi;

  /**
   * The top-level JSON values of a text, as `[start, end)` ranges. A batch is several objects (one per line or in
   * its own fenced block), and the page collapses its line breaks into spaces, so the values are found by bracket
   * balance, not by splitting lines. Strings are respected: a brace inside an argument never splits a call.
   * @returns {{start:number,end:number}[]|null} null when the brackets do not balance
   */
  function jsonValueRanges(text) {
    const ranges = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') { if (depth === 0) start = i; depth += 1; }
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth < 0) return null;
        if (depth === 0) { ranges.push({ start, end: i + 1 }); start = -1; }
      }
    }
    return depth === 0 ? ranges : null;
  }

  /**
   * A call value — `{"mcp_call": {"name": …}}` — or null when the JSON is not one. A name or server that is still
   * the instruction's placeholder is an echo of the format, not a call.
   */
  function callOf(parsed) {
    const call = parsed?.mcp_call;
    if (!call || typeof call.name !== 'string' || !call.name) return null;
    if (isFrameValue(call.name) || isFrameValue(call.server)) return null;
    return {
      server: typeof call.server === 'string' ? call.server : '',
      name: call.name,
      json: JSON.stringify({ mcp_call: call }, null, 2), // what the line shows when it is opened
    };
  }

  /** The calls of one top-level JSON value (a call object, or a non-empty array of them), or null. */
  function callsOfValue(text) {
    let parsed;
    for (const candidate of [text, text.replace(/[\u201c\u201d\u201e\u2033]/g, '"')]) {
      try { parsed = JSON.parse(candidate); break; } catch { /* try the next form */ }
    }
    if (Array.isArray(parsed)) {
      const calls = parsed.map(callOf);
      return calls.length > 0 && calls.every(Boolean) ? calls : null;
    }
    const one = callOf(parsed);
    return one ? [one] : null;
  }

  /**
   * The calls a text is NOTHING but — one object, an array, or several objects (one per line or per fenced
   * block) — or null. A fence and the caption a rendered code block carries around the code (`JSON`, `Copy
   * code`) are tolerated: they are not part of it. `tolerant` also allows that small print BETWEEN blocks,
   * which is what a message holding several rendered code blocks looks like; prose never is.
   * @param {string} text
   * @param {boolean} [tolerant]
   * @returns {{server:string,name:string,json:string}[]|null}
   */
  function parsePureCalls(text, tolerant = false) {
    const bare = String(text ?? '').trim()
      .replace(/^```[a-z0-9_-]*\s*/i, '').replace(/\s*```$/, '')
      .replace(EDGE_CHROME, '')
      .trim();
    if (!bare.includes('mcp_call')) return null;

    // The page collapses line breaks into spaces and may keep the fences, so the values are found by bracket
    // balance, not by splitting lines. Strings are respected: a brace inside an argument never splits a call.
    const values = jsonValueRanges(bare);
    if (!values || values.length === 0) return null;
    let outside = '';
    let at = 0;
    for (const value of values) {
      outside += bare.slice(at, value.start);
      at = value.end;
    }
    outside += bare.slice(at);
    outside = outside.replace(/```[a-z0-9_-]*/gi, '');
    if (tolerant) outside = outside.replace(BETWEEN_CHROME, '');
    if (outside.trim()) return null;

    const calls = [];
    for (const value of values) {
      const part = callsOfValue(bare.slice(value.start, value.end));
      if (!part) return null;
      calls.push(...part);
    }
    return calls.length ? calls : null;
  }

  /** Is this text nothing but one or more `mcp_call` objects? (the result/quoted-message decisions use this) */
  function isPureCall(text) {
    return parsePureCalls(text) !== null;
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

  /** Hides a message that is nothing but generated text. Its text stays in the DOM. Null when it was hidden already. */
  function hideMessage(el, whole = true) {
    const target = messageElement(el, whole);
    if (target.hasAttribute(MESSAGE_ATTR)) return null;
    try { target.setAttribute(DISPLAY_ATTR, JSON.stringify({ value: target.style.getPropertyValue('display'), priority: target.style.getPropertyPriority('display') })); } catch { /* noop */ }
    target.setAttribute(MESSAGE_ATTR, '1');
    target.style.setProperty('display', 'none', 'important');
    return target;
  }

  // ───────────────────────── The compact line ─────────────────────────
  // A hidden message does not vanish without a trace: one short terminal-style line says what ran, so the chat
  // reads like a coding tool. A call gets its line at once (`running`), and the line becomes the result's when
  // that arrives. The raw text of what the line stands for is kept beside it (the call's JSON, the result's
  // body): clicking the line opens exactly that one, right under it, so a batch stays independent widgets.

  const CHIP_STYLE = 'display:flex;align-items:center;gap:8px;width:fit-content;max-width:100%;'
    + 'margin:6px 0;padding:5px 10px;border:1px solid rgba(128,128,128,.28);border-radius:8px;'
    + 'background:rgba(128,128,128,.10);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
    + 'cursor:pointer;user-select:none;align-self:flex-start;box-sizing:border-box;direction:ltr';
  const DETAIL_STYLE = 'display:none;margin:-2px 0 8px;padding:8px 10px;border:1px solid rgba(128,128,128,.22);'
    + 'border-radius:8px;background:rgba(128,128,128,.06);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
    + 'white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;direction:ltr;text-align:left;box-sizing:border-box';
  const STATUS_COLOR = {
    ok: '#22c55e', error: '#ef4444', rejected: '#f59e0b', format_error: '#f59e0b',
    running: '#60a5fa', stale: '#94a3b8',
  };
  /** A `running` line whose result never arrives stops claiming it is running (the queue's own bound is 10 min). */
  const PENDING_STALE_MS = 620_000;

  /** Result lines, and the `running` line each hidden call left behind, waiting for its result. */
  const chips = [];
  const pending = [];

  /** A `server="…"` attribute of a result header (typographic quotes are tolerated, as everywhere else). */
  function headerAttr(header, name) {
    return new RegExp(`${name}\\s*=\\s*["\u201c\u201d']?([^\\s"\u201c\u201d'\\]]+)`, 'i').exec(header)?.[1] ?? '';
  }

  function span(text, style) {
    const el = document.createElement('span');
    applyStyle(el, style);
    el.append(text);
    return el;
  }

  /** Inline styles through CSSOM: a page's CSP can block a `style` attribute, but not these setters. */
  function applyStyle(el, css) {
    for (const rule of String(css ?? '').split(';')) {
      const at = rule.indexOf(':');
      if (at > 0) el.style.setProperty(rule.slice(0, at).trim(), rule.slice(at + 1).trim());
    }
  }

  /**
   * The shell of a line: caret, status dot, `MCP`, `server › tool`, an optional status word. A click (or Enter)
   * toggles the detail that follows it — never the message it stands before.
   * @returns {{chip:HTMLElement, caret:HTMLElement, dot:HTMLElement, statusEl:HTMLElement|null, setWord:(word:string)=>void}}
   */
  function makeChip(detail, { server, tool, status, color, show, hide }) {
    const chip = document.createElement('div');
    chip.setAttribute(CHIP_ATTR, '1');
    applyStyle(chip, CHIP_STYLE);
    chip.setAttribute('role', 'button');
    chip.tabIndex = 0;

    const name = [server, tool].filter(Boolean).join(' \u203a ') || 'MCP call';
    let word = status ? status.replace(/_/g, ' ') : '';
    const caret = span('\u25b8');
    const dot = span('\u25cf', `color:${color};font-size:10px`);
    const statusEl = word ? span(`\u00b7 ${word}`, 'opacity:.8') : null;
    chip.append(
      caret,
      dot,
      span('MCP', 'opacity:.55;letter-spacing:.08em;font-size:10px'),
      span(name, 'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'),
    );
    if (statusEl) chip.append(statusEl);

    let open = false;
    const sync = () => {
      chip.title = open ? hide : show;
      chip.setAttribute('aria-expanded', open ? 'true' : 'false');
      chip.setAttribute('aria-label', `MCP ${name}${word ? ` \u2014 ${word}` : ''}. ${chip.title}`);
      if (caret.firstChild) caret.firstChild.nodeValue = open ? '\u25be' : '\u25b8';
    };
    const toggle = () => {
      open = !open;
      if (open) detail.style.removeProperty('display');
      else detail.style.setProperty('display', 'none', 'important');
      sync();
    };
    chip.addEventListener('click', toggle);
    chip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    });
    sync();

    const setWord = (next) => {
      word = next;
      if (statusEl?.firstChild) statusEl.firstChild.nodeValue = next ? `\u00b7 ${next}` : '';
      sync();
    };
    return { chip, caret, dot, statusEl, setWord };
  }

  /**
   * One line and the detail it opens, inserted together before the hidden message — the line first, its own
   * detail right after it — so every block of a batch expands independently.
   */
  function addLine(target, { server, tool, status, color, show, hide, text, detailLabel, running = false }) {
    const detail = document.createElement('pre');
    detail.setAttribute(DETAIL_ATTR, '1');
    applyStyle(detail, DETAIL_STYLE);
    detail.setAttribute('aria-label', detailLabel);
    detail.append(text);

    const made = makeChip(detail, { server, tool, status, color, show, hide });
    const line = { ...made, detail };
    if (running) {
      line.animation = made.dot.animate?.(
        [{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }],
        { duration: 1200, iterations: Infinity },
      );
    }
    target.parentNode.insertBefore(line.chip, target);
    target.parentNode.insertBefore(detail, target);
    return line;
  }

  /** A result's line: its status word only when it is not ok (the dot carries `ok`). */
  function addResultLine(header, body, target) {
    const status = headerAttr(header, 'status');
    return addLine(target, {
      server: headerAttr(header, 'server'),
      tool: headerAttr(header, 'tool'),
      status: status && status !== 'ok' ? status : '',
      color: STATUS_COLOR[status] ?? STATUS_COLOR.stale,
      show: 'Show the full result',
      hide: 'Hide the result',
      text: body || '(the result was empty)',
      detailLabel: 'The raw result',
    });
  }

  /** The `running` line a call leaves until its result arrives; its detail is the call's JSON. */
  function addCallLine(call, target) {
    return addLine(target, {
      server: call.server,
      tool: call.name,
      status: 'running',
      color: STATUS_COLOR.running,
      show: 'Show the full call',
      hide: 'Hide the call',
      text: call.json,
      detailLabel: 'The call sent',
      running: true,
    });
  }

  /** The `running` line of this result, if its call is still waiting: exact names first, then the tool alone
   *  (a wrong server name is answered under the bridge's own name, with the requested tool). Only a call in the
   *  same tree can be waiting for it. */
  function takePending(server, tool, resultTarget) {
    const slug = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const root = (node) => { let at = node; while (at?.parentNode) at = at.parentNode; return at; };
    const tree = root(resultTarget);
    const waiting = (entry) => root(entry.target) === tree;
    let at = pending.findIndex((entry) => waiting(entry) && slug(entry.server) === slug(server) && slug(entry.name) === slug(tool));
    if (at === -1) at = pending.findIndex((entry) => waiting(entry) && slug(entry.name) === slug(tool));
    if (at === -1 && slug(server) === 'bridge' && slug(tool) === 'listtools') {
      at = pending.findIndex((entry) => waiting(entry) && slug(entry.server) === 'bridge');
    }
    if (at === -1) return;
    const [entry] = pending.splice(at, 1);
    entry.animation?.cancel();
    entry.chip.remove();
    entry.detail.remove();
  }

  /** A batch result is several blocks in one message: one line (with its own detail) per block. */
  function addResultChips(target, text) {
    if (!target.parentNode) return;
    for (const match of String(text).matchAll(RESULT_BLOCK)) {
      takePending(headerAttr(match[1], 'server'), headerAttr(match[1], 'tool'), target);
      const line = addResultLine(match[1], match[2].trim(), target);
      chips.push({ chip: line.chip, detail: line.detail, target });
    }
  }

  /** The line(s) a call leaves while it runs; the result's line replaces them when the result arrives. */
  function addCallChips(target, text) {
    if (!target.parentNode) return;
    const calls = parsePureCalls(text, true);
    if (!calls) return;
    for (const call of calls) {
      const line = addCallLine(call, target);
      pending.push({ ...line, target, server: call.server, name: call.name, at: Date.now() });
    }
  }

  /** Put a line's two nodes back before its message, in order (the site may have dropped one of them). */
  function placeLine(line) {
    line.chip.remove();
    line.detail.remove();
    line.target.parentNode.insertBefore(line.chip, line.target);
    line.target.parentNode.insertBefore(line.detail, line.target);
  }

  /** A line whose message is gone must not keep claiming anything; one the site dropped goes back in place. */
  function pruneChips() {
    for (let i = chips.length - 1; i >= 0; i -= 1) {
      const line = chips[i];
      if (!line.target.parentNode) {
        line.chip.remove();
        line.detail.remove();
        chips.splice(i, 1);
      } else if (!line.chip.parentNode || !line.detail.parentNode) {
        placeLine(line); // the site re-rendered the message but dropped the line
      }
    }
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const entry = pending[i];
      if (!entry.target.parentNode) {
        entry.animation?.cancel();
        entry.chip.remove();
        entry.detail.remove();
        pending.splice(i, 1);
        continue;
      }
      if (!entry.chip.parentNode || !entry.detail.parentNode) placeLine(entry);
      // A call that is no longer the newest thing on the page is history (the chat finished rendering, or the
      // user moved on): keeping its `running` line would be a lie. The result's own line stands on its own.
      if (!isLatestMessage(entry.target)) {
        entry.animation?.cancel();
        entry.chip.remove();
        entry.detail.remove();
        pending.splice(i, 1);
        continue;
      }
      if (entry.at + PENDING_STALE_MS < Date.now()) {
        entry.at = Infinity; // once
        entry.animation?.cancel();
        entry.dot.style.setProperty('color', STATUS_COLOR.stale);
        entry.setWord('no result');
      }
    }
  }

  /** The bridge will not deliver a result for this call (ignored, or delivery failed): the `running` line must
   *  not linger. With a call, only that call's line goes; without, every running line of this message.
   *  Called by core_bridge on the paths that produce no result. */
  function dropped(element, call = null) {
    const root = element?.__raw ?? element; // ChatGPT's Proxy (see running())
    if (!root) return;
    const slug = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const inMessage = (entry) => entry.target === root || root.contains(entry.target) || entry.target.contains(root);
    const wanted = call
      ? (entry) => slug(entry.server) === slug(call.server) && slug(entry.name) === slug(call.name)
      : () => true;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const entry = pending[i];
      if (!inMessage(entry) || !wanted(entry)) continue;
      entry.animation?.cancel();
      entry.chip.remove();
      entry.detail.remove();
      pending.splice(i, 1);
    }
  }

  // ───────────────────────── Applying the plan ─────────────────────────

  /** Applies the plan to one message: hide the whole thing, or wrap the parts the extension wrote. */
  function applyHidden({ el, index, ranges, call, whole }) {
    // A pure call has no partial plan: its whole text is generated and disappears like a result.
    if (call || !remainingText(index.text, ranges).trim()) {
      const target = hideMessage(el, call ? whole !== false : true);
      if (target && !call) addResultChips(target, index.text);
      return;
    }
    // From the end backwards: wrapping a range splits its text node, and the earlier offsets must stay valid.
    for (let i = ranges.length - 1; i >= 0; i -= 1) wrapRange(index, toRawRange(index, ranges[i]));
  }

  /**
   * The bridge is starting the call in this message NOW. This is the ONLY source of a `running` line: a call
   * sitting in history was never detected as live, so a reopened chat can never claim one is running. Hiding is
   * done here too (when the scan has not got to it yet), so the raw protocol never flashes on screen.
   * Called by core_bridge with the assistant message element the adapter detected the call in.
   */
  function running(element) {
    const root = element?.__raw ?? element; // ChatGPT hands its block-aware Proxy: hide needs the real node
    if (!enabled || !root || root.nodeType !== 1) return;
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue.includes('mcp_call')) nodes.push(node);
    }
    // Where each call's line goes, and the text to read its calls from: the message the adapter saw (a bubble
    // above it may carry a timestamp), or the block itself when the scan hid only part of a longer reply.
    const hosts = new Map();
    for (const node of nodes) {
      if (node.parentElement?.closest(`[${HIDDEN_ATTR}], [${CHIP_ATTR}], [${DETAIL_ATTR}]`)) continue;
      const found = findTarget(node);
      if (!found) continue;
      let host = null;
      try { host = hideMessage(found.el, found.whole !== false); } catch { /* the next scan retries */ }
      host = host ?? found.el.closest(`[${MESSAGE_ATTR}]`) ?? found.el;
      hosts.set(host, host.contains(root) || host === root ? root.textContent : host.textContent);
    }
    for (const [host, text] of hosts) {
      if (pending.some((entry) => entry.target === host || host.contains(entry.target))) continue;
      addCallChips(host, text);
    }
  }

  /**
   * Is this the newest message on the page? A call that is no longer the newest has been answered or the user
   * moved on; a `running` line left for it would be a lie. (Whether a call is running at all is decided by
   * core_bridge, which reports its own detections — see `running()`.)
   */
  function isLatestMessage(el) {
    const anyMessage = `${MESSAGE_SEL}, ${ASSISTANT_SEL}, ${USER_SEL}`;
    for (let at = el; at && at !== document.body && at !== document.documentElement; at = at.parentElement) {
      for (let sibling = at.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        if (sibling.matches(anyMessage) || sibling.querySelector(anyMessage)) return false;
      }
    }
    return true;
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
      // Our own lines carry the call's text (`mcp_call` in the detail). They are never messages: scanning them
      // would hide them and add another line — a loop that grew the chat without end.
      if (el.closest(`[${CHIP_ATTR}], [${DETAIL_ATTR}]`)) return null;
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
      // message: past the prose bound only call-shaped text is indexed, and the hard bound stops outright (which
      // keeps textIndex off the large elements of the conversation).
      if (inAssistant) {
        const text = el.textContent ?? '';
        if (text.length > MAX_CALL_CHARS) return null;
        if (text.length > CALL_PROSE_CHARS && !CALL_SHAPE.test(text.trimStart())) return null;
      }
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
        // A batch may render one call per block. When the whole message is nothing but calls (plus the small
        // print blocks carry), hiding only the found block would leave an empty bubble behind: the message goes,
        // and every call in it leaves its `running` line when the bridge starts it.
        if (holder !== el && parsePureCalls(COLLAPSE(holder.textContent), true)) {
          return { el: holder, index: textIndex(holder), ranges: [], call: true, whole: true };
        }
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
    pruneChips();
    refreshSelectors(); // the site's adapter (when there is one) contributes its own selectors to this pass
    let found;
    try { found = document.evaluate(XPATH, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); } catch { return; }
    for (let i = 0; i < found.snapshotLength; i += 1) {
      const node = found.snapshotItem(i);
      const parent = node?.parentElement;
      if (!parent || parent.closest(`[${HIDDEN_ATTR}], [${MESSAGE_ATTR}], [${CHIP_ATTR}], [${DETAIL_ATTR}]`)) continue; // already hidden, or ours
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
    for (const entry of pending) entry.animation?.cancel();
    for (const el of document.querySelectorAll?.(`[${CHIP_ATTR}], [${DETAIL_ATTR}]`) ?? []) el.remove();
    chips.length = 0;
    pending.length = 0;
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
    running,
    dropped,
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
    // Lines left behind by a previous copy of this script (an extension reload): this instance owns none yet, and
    // a stale `running` line from that copy would never be withdrawn. The scan below recreates the current ones.
    for (const el of document.querySelectorAll?.(`[${CHIP_ATTR}], [${DETAIL_ATTR}]`) ?? []) el.remove();
    // Enabled from the start, before the extension has said anything: the protocol must never be on screen just
    // because a state query was slow or failed. The setting can only turn it off afterwards.
    start();
    scan();
    // A hidden tab is throttled; when it comes back, whatever arrived meanwhile is cleaned up at once.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scan(); });
    if (typeof window !== 'undefined') window.addEventListener('focus', () => scan());
  }
})();
