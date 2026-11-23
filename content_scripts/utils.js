/**
 * utils.js — Utilities shared by all content scripts.
 * Defines the global `WMB` namespace (LongArm).
 */
(() => {
  'use strict';
  const WMB = (globalThis.WMB = globalThis.WMB || {});
  WMB.VERSION = '0.1.0';

  const nativeSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Message to the service worker (never throws). */
  WMB.bg = async (message) => {
    try { return await globalThis.chrome?.runtime?.sendMessage(message); } catch { return null; }
  };

  /** Is the tab hidden, covered by another window or unfocused? That is where Chrome/Brave throttle the page timers. */
  WMB.isBackground = () => typeof document !== 'undefined'
    && (Boolean(document.hidden) || (typeof document.hasFocus === 'function' && !document.hasFocus()));

  /**
   * Pause that does NOT freeze in the background: with the tab hidden, the service worker counts the timer
   * (setTimeout in a hidden tab is throttled to 1 s and, after 5 min, to 1 per minute). If it fails, it uses setTimeout.
   *
   * Pauses longer than 30 s are sent as SEVERAL ones: the worker clamps every pause to 30 s, and the leftover
   * of a single longer one would be counted by this page's throttled setTimeout — exactly what WMB.sleep
   * exists to avoid.
   */
  WMB.sleep = async (ms) => {
    if (!WMB.isBackground() || !globalThis.chrome?.runtime?.sendMessage) return nativeSleep(ms);
    let left = ms;
    while (left > 20) {
      if (!WMB.isBackground()) { await nativeSleep(left); return; } // visible again: the page timers count normally
      const started = Date.now();
      const chunk = Math.min(left, 30_000);
      await Promise.race([
        WMB.bg({ type: 'SLEEP', ms: chunk }),
        nativeSleep(chunk + 3000), // safety net if the service worker does not answer
      ]);
      const waited = Date.now() - started;
      // Guarantee: a pause always lasts (almost) as requested. If the service worker answered at once (extension
      // reloaded, error…) it is completed with setTimeout, so no loop can spin unchecked and hang the tab.
      if (waited < chunk / 2) { await nativeSleep(left); return; }
      left -= waited;
    }
  };

  /** Is the extension still alive for this content script? (after a reload the old script is orphaned). */
  WMB.extensionAlive = () => !globalThis.chrome?.runtime || Boolean(globalThis.chrome.runtime.id);

  /** Retries `fn` until it returns a truthy value or the timeout expires. */
  WMB.waitFor = async (fn, { timeout = 3000, interval = 100 } = {}) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = fn();
      if (value) return value;
      await WMB.sleep(interval);
    }
    return fn() || null;
  };

  /** Fast hash (djb2) to generate call IDs. */
  WMB.hash = (input) => {
    const text = String(input ?? '');
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };

  /** Generates a standard UUID v4 for unique request identification. */
  WMB.generateUuid = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };

  /**
   * RequestLifecycle — State machine managing the lifecycle of an MCP tool invocation:
   *   'queued' -> 'running' -> 'completed' | 'failed' | 'timeout' | 'cancelled'
   */
  class RequestLifecycle {
    constructor(call, { requestId = null } = {}) {
      this.id = requestId || WMB.generateUuid();
      this.call = call;
      this.state = 'queued';
      this.createdAt = new Date().toISOString();
      this.startedAt = null;
      this.finishedAt = null;
      this.durationMs = 0;
      this.cached = false;
      this.result = {
        stdout: '',
        stderr: '',
        exit_code: 0,
      };
      this._startTimestamp = null;
    }

    start() {
      this.state = 'running';
      this.startedAt = new Date().toISOString();
      this._startTimestamp = Date.now();
      return this;
    }

    finish({ state = 'completed', stdout = '', stderr = '', exitCode = 0, cached = false, durationMs = null } = {}) {
      this.state = state;
      this.finishedAt = new Date().toISOString();
      this.durationMs = typeof durationMs === 'number'
        ? Math.round(durationMs)
        : (this._startTimestamp ? Date.now() - this._startTimestamp : 0);
      this.cached = Boolean(cached);
      this.result = {
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exit_code: typeof exitCode === 'number' ? exitCode : (state === 'completed' ? 0 : 1),
      };
      return this;
    }

    toJSON() {
      return {
        request_id: this.id,
        status: this.state,
        execution: {
          started_at: this.startedAt || this.createdAt,
          finished_at: this.finishedAt || this.createdAt,
          duration_ms: this.durationMs,
        },
        result: this.result,
        cached: this.cached,
      };
    }
  }

  WMB.RequestLifecycle = RequestLifecycle;

  // ───────────────────────── Flexible selectors ─────────────────────────

  WMB.isVisible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  /** First VISIBLE element matching any of the selectors (in priority order). */
  WMB.firstVisible = (selectors, root = document, { loose = false } = {}) => {
    for (const selector of selectors) {
      try {
        for (const el of root.querySelectorAll(selector)) if (WMB.isVisible(el)) return el;
      } catch { /* invalid selector: ignored */ }
    }
    // Minimized or covered window: the browser may report size 0; with `loose` the first match is accepted.
    if (loose) {
      for (const selector of selectors) {
        try { const el = root.querySelector(selector); if (el) return el; } catch { /* noop */ }
      }
    }
    return null;
  };

  WMB.exists = (selectors, root = document) => {
    for (const selector of selectors) {
      try { if (root.querySelector(selector)) return true; } catch { /* noop */ }
    }
    return false;
  };

  /** All elements from the FIRST selector that returns results. */
  WMB.allMatches = (selectors, root = document) => {
    for (const selector of selectors) {
      try {
        const found = Array.from(root.querySelectorAll(selector));
        if (found.length) return found;
      } catch { /* noop */ }
    }
    return [];
  };

  /**
   * Is this element part of a Writing Block (Canvas, Artifact, document editor, side panel) rather than the chat?
   *
   * Only EXPLICIT writing-block containers count. An earlier version also flagged "any contenteditable outside a
   * <form>" and "any <article>/region without a send button" — which is exactly the chat itself: ChatGPT renders
   * the composer and every message turn outside a <form>, so the main composer was refused and results were
   * never written into the chat.
   */
  WMB.isWritingBlock = (el) => {
    if (!el || typeof el.closest !== 'function') return false;

    try {
      // The chat composer itself is never a writing block, wherever the site puts it.
      if (el.id === 'prompt-textarea' || el.closest('#prompt-textarea')) return false;
      const chatForm = el.closest('form');
      if (chatForm && (chatForm.querySelector('#prompt-textarea') || chatForm.querySelector('button[data-testid*="send" i]'))) return false;

      const blockContainer = el.closest([
        'aside',
        '[data-testid*="canvas" i]',
        '[data-testid*="document" i]',
        '[data-testid*="artifact" i]',
        '[data-testid*="code-editor" i]',
        '.canvas-editor',
        '.canvas-container',
        '[class*="canvas" i]',
        '[class*="editor-panel" i]',
        '[class*="side-panel" i]',
        '[data-editor="canvas" i]',
      ].join(', '));
      if (blockContainer) return true;

      const testId = el.getAttribute?.('data-testid') || '';
      const className = String(el.className || '');
      return el.getAttribute?.('data-editor') === 'canvas' || /canvas|document-editor/i.test(testId) || /canvas-editor|document-editor/i.test(className);
    } catch {
      return false; // an exception here must never block the chat: the explicit containers above are the protection
    }
  };

  // ───────────────────────── MCP call parser ─────────────────────────

  /** Returns the index of the brace closing the JSON object starting at `start`, or -1. */
  function findBalancedEnd(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) return i;
    }
    return -1;
  }

  function scanCalls(text) {
    const calls = [];
    const marker = '"mcp_call"';
    let from = 0;
    for (;;) {
      const at = text.indexOf(marker, from);
      if (at === -1) break;
      from = at + marker.length;
      const start = text.lastIndexOf('{', at);
      if (start === -1) continue;
      const end = findBalancedEnd(text, start);
      if (end === -1) continue;
      try {
        const call = JSON.parse(text.slice(start, end + 1))?.mcp_call;
        if (call && typeof call.name === 'string' && call.name) {
          let args = call.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } } // some models serialize the arguments
          calls.push({
            server: typeof call.server === 'string' ? call.server : null,
            name: call.name,
            arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
          });
          from = end + 1;
        }
      } catch { /* incomplete or invalid JSON */ }
    }
    return calls;
  }

  /**
   * The BASIC reader: the valid `{"mcp_call": {...}}` objects in a message text, with the whitespace and the
   * curly quotes of a renderer tolerated. It is the first layer of the parser and the only one that lives here —
   * `mcp_parser.js` (loaded right after) builds the public `WMB.extractMcpCalls` on top of it: the same reading
   * plus the repairs, the lenient pass and the schema-guided flags. Read this one directly only when valid JSON
   * is all that can be there (a tool result, a placeholder check…).
   * @returns {{server:string|null,name:string,arguments:object}[]}
   */
  WMB.scanCallsText = (rawText) => {
    const raw = String(rawText).replace(/[\u00a0\u200b\u2028\u2029]/g, ' ');
    const calls = scanCalls(raw);
    if (calls.length || !raw.includes('mcp_call')) return calls;
    // Last resort: some renderers turn straight quotes into curly ones (“ ”).
    return scanCalls(raw.replace(/[“”„‟″]/g, '"'));
  };

  // ───────────────────────── MCP results (nothing omitted) ─────────────────────────

  const EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
    'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'application/pdf': 'pdf', 'application/json': 'json', 'text/plain': 'txt',
  };
  const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const cleanB64 = (data) => String(data).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  const sameJson = (a, b) => { try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(b); } catch { return false; } };

  /**
   * Turns the MCP result (`content[]`) into text parts + files.
   * Text, resources and structuredContent go inline; images, audio and blobs are attached as files.
   * @returns {{parts:(string|{file:object,label:string})[], files:{name:string,mime:string,b64:string,bytes:number}[]}}
   */
  WMB.parseResult = (result, base = 'result') => {
    const parts = [];
    const files = [];
    const attach = (data, mime, label) => {
      const mimeType = mime || 'application/octet-stream';
      const b64 = cleanB64(data);
      const ext = EXT[mimeType] ?? (mimeType.split('/')[1] ?? 'bin').split(/[+;]/)[0];
      const file = { name: `${base}_${files.length + 1}.${ext}`, mime: mimeType, b64, bytes: Math.floor((b64.length * 3) / 4) };
      files.push(file);
      parts.push({ file, label });
    };

    let textParts = 0;
    for (const item of result?.content ?? []) {
      if (item.type === 'text') { parts.push(item.text ?? ''); textParts += 1; }
      else if ((item.type === 'image' || item.type === 'audio') && typeof item.data === 'string') attach(item.data, item.mimeType, item.type === 'image' ? 'image' : 'audio');
      else if (item.type === 'resource' && item.resource) {
        const { uri = '', text, blob, mimeType } = item.resource;
        if (typeof text === 'string') parts.push(`[resource ${uri}]\n${text}`);
        else if (typeof blob === 'string') attach(blob, mimeType, `resource ${uri}`.trim());
        else parts.push(JSON.stringify(item));
      } else if (item.type === 'resource_link') {
        parts.push(`[link: ${[item.uri, item.name, item.description].filter(Boolean).join(' · ')}]`);
      } else parts.push(JSON.stringify(item)); // unknown type: kept as is
    }
    const structured = result?.structuredContent;
    if (structured !== undefined && structured !== null) {
      const duplicated = (result.content ?? []).some((c) => c.type === 'text' && sameJson(c.text, structured));
      if (!duplicated) parts.push(JSON.stringify(structured, null, 2));
    }
    return { parts, files, hasText: textParts > 0 };
  };

  /** Joins the parts into text; `attached` tells whether the files reached the chat as attachments. */
  WMB.renderParts = (parts, attached = true) => parts
    .map((p) => (typeof p === 'string' ? p
      : attached ? `[${p.label} attached to this message: ${p.file.name} (${p.file.mime}, ${kb(p.file.bytes)})]`
        : `[${p.label} NOT attached (the browser downloaded it): ${p.file.name} (${p.file.mime}, ${kb(p.file.bytes)})]`))
    .join('\n');

  /** Message written into the chat with the tool result. */
  WMB.formatToolResult = ({ server, name, status, text }) => `[MCP_RESULT server="${server}" tool="${name}" status="${status}"]\n${text ?? ''}\n[/MCP_RESULT]`;

  const PREVIEW_CHARS = 1500;

  /**
   * Delivery plan for an MCP result with NO information loss:
   *  - images/audio/blobs → attached files;
   *  - text longer than `maxChars` → attached IN FULL as .txt and an excerpt is left inline.
   * If the attachment fails, `build(false)` leaves ALL the text inline.
   * `serial` (1-based, optional) is the call's position in a batch: it keeps two results of the SAME
   * server/tool from attaching files under the SAME name, so each result's markers point at its own file.
   * @returns {{files:object[], build:(attached:boolean)=>string}}
   */
  // The default cap comes from the shared settings (content_scripts/constants.js, generated from shared/).
  WMB.planResult = (result, { server, name, status, maxChars = WMB.defaults.settings.maxResultChars, serial = 0 }) => {
    const stem = `${server}_${name}`.replace(/[^\w.-]+/g, '_').slice(0, 40);
    const base = serial ? `${stem}_${serial}` : stem;
    const { parts, files } = WMB.parseResult(result, base);
    const full = WMB.renderParts(parts, true);
    let overflow = null;
    if (full.length > maxChars) {
      overflow = { name: `${base}_full.txt`, mime: 'text/plain', text: full, bytes: full.length, overflow: true };
      files.push(overflow);
    }
    const build = (attached) => {
      let text = WMB.renderParts(parts, attached);
      if (overflow && attached) {
        text = `${text.slice(0, PREVIEW_CHARS)}\n…\n[result of ${full.length} characters: FULL content in the attached file ${overflow.name}]`;
      }
      return WMB.formatToolResult({ server, name, status, text });
    };
    return { files, build };
  };

  // ───────────────────────── Writing into the text box ─────────────────────────

  const dom = (WMB.dom = {});

  dom.getText = (el) => (!el ? '' : (('value' in el) && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement))) ? el.value : (el.innerText || el.textContent || ''));

  /**
   * Completely clears the text box (both textarea and contenteditable / ProseMirror).
   * Ensures internal framework / React / ProseMirror state recognizes the empty input.
   * Strictly verifies target and activeElement so Writing Blocks (Canvas/Artifacts) are never touched!
   */
  dom.clearText = async (el) => {
    if (!el || WMB.isWritingBlock?.(el)) return;

    // Blur activeElement if it is currently in a writing block to protect it from any command
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active && active !== el && WMB.isWritingBlock?.(active)) {
      try { active.blur(); } catch { /* noop */ }
    }

    const isInput = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
    if (isInput) {
      try { el.focus(); } catch { /* noop */ }
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    // contenteditable / ProseMirror
    try {
      el.focus();
      const isTargetFocused = document.activeElement === el || (document.activeElement && el.contains(document.activeElement));
      const selection = globalThis.getSelection?.() || document?.getSelection?.();
      const isSelectionInTarget = selection?.anchorNode && (selection.anchorNode === el || el.contains(selection.anchorNode));

      // ONLY call execCommand if el is genuinely focused, selection is inside el, and activeElement is NOT a writing block!
      if (isTargetFocused && isSelectionInTarget && !WMB.isWritingBlock?.(document.activeElement)) {
        if (selection && document.createRange) {
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('delete', false, null);
        }
      }
    } catch { /* noop */ }

    // If text still remains (e.g. ProseMirror didn't clear), reset children directly on el
    if (dom.getText(el).trim().length > 0) {
      try {
        if (typeof el.replaceChildren === 'function') {
          el.replaceChildren();
          const p = document.createElement('p');
          p.append(document.createElement('br'));
          el.append(p);
        } else {
          el.innerHTML = '<p><br></p>';
        }
      } catch {
        el.textContent = '';
      }
    }

    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch { /* noop */ }
  };

  /** Builds a `File` from `{name, mime, b64}` or `{name, mime, text}`. */
  dom.fileFrom = ({ name, mime, b64, text }) => {
    if (b64 === undefined) return new File([text ?? ''], name, { type: mime });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime });
  };

  /** Downloads a file (last resort when it cannot be attached to the chat: nothing is lost this way). */
  dom.download = (file) => {
    const url = URL.createObjectURL(file);
    const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  /**
   * Writes text into a <textarea> or a contenteditable editor (ProseMirror, Quill, Lexical…)
   * so that the page framework detects the change.
   *
   * Order matters: a real paste is tried FIRST, because editors keep the line breaks of pasted text while the
   * execCommand path can quietly turn them into spaces (the instruction block then arrives as one paragraph).
   * Only if the paste did not land — or landed without the line breaks the text has — the execCommand path and
   * finally a direct assignment are used.
   * @param {{append?:boolean, pasteFirst?:boolean}} options
   */
    /**
   * Safely writes text directly into a contenteditable editor (ProseMirror, etc.) using DOM manipulation.
   * This is 100% scoped to `el` and CANNOT touch document.activeElement or any Writing Block.
   */
  dom.setDirectText = (el, text, { append = true } = {}) => {
    if (!el || WMB.isWritingBlock?.(el)) return false;
    const hadText = dom.getText(el).trim().length > 0;
    const lines = text.split('\n');

    if (!append || !hadText) {
      if (typeof el.replaceChildren === 'function') {
        el.replaceChildren();
        for (const line of lines) {
          const p = document.createElement('p');
          if (line) p.textContent = line;
          else p.appendChild(document.createElement('br'));
          el.appendChild(p);
        }
      } else {
        el.innerHTML = lines.map((l) => `<p>${l || '<br>'}</p>`).join('');
      }
    } else {
      for (const line of lines) {
        const p = document.createElement('p');
        if (line) p.textContent = line;
        else p.appendChild(document.createElement('br'));
        el.appendChild(p);
      }
    }

    // The paragraphs above ARE the content: rewriting textContent here would flatten them into a single text node
    // (and, in a controlled editor, be reverted while still reading back as "written").
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch { /* noop */ }
    return dom.getText(el).length > 0;
  };

  /**
   * Writes text into a <textarea> or a contenteditable editor (ProseMirror, Quill, Lexical…)
   * so that the page framework detects the change.
   *
   * Strictly validates target and active element so Writing Blocks (Canvas / Artifacts) are never touched!
   * @param {{append?:boolean, pasteFirst?:boolean}} options
   */
  dom.setText = async (el, text, { append = true, pasteFirst = true } = {}) => {
    // 1. Target validation: abort immediately if target is missing or a Writing Block
    if (!el || WMB.isWritingBlock?.(el)) {
      return false;
    }

    // 2. Guard against active focus in Writing Blocks: blur immediately to protect it
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active && active !== el && WMB.isWritingBlock?.(active)) {
      try { active.blur(); } catch { /* noop */ }
    }

    const isInput = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
    if (isInput) {
      try { el.focus(); } catch { /* noop */ }
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const previous = append ? el.value : '';
      const next = previous ? `${previous}\n\n${text}` : text;
      if (setter) setter.call(el, next);
      else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.setSelectionRange?.(el.value.length, el.value.length);
      return true;
    }

    // Try focusing the target element
    try {
      el.focus();
      if (document.activeElement !== el && !el.contains(document.activeElement)) {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        el.focus();
      }
    } catch { /* noop */ }

    const isTargetFocused = () => {
      const act = document.activeElement;
      return act === el || Boolean(act && el.contains(act));
    };

    const isSelectionInTarget = () => {
      try {
        const sel = typeof getSelection === 'function' ? getSelection() : document.getSelection();
        if (!sel || !sel.anchorNode) return false;
        return sel.anchorNode === el || el.contains(sel.anchorNode);
      } catch {
        return false;
      }
    };

    // The target is the chat composer (a writing block was refused at the top), so focus and caret are placed
    // HERE instead of bailing out: a React/ProseMirror composer ignores raw textContent writes, so the direct-DOM
    // path produced empty sends (the text looked written, the editor state never got it, nothing was submitted).
    if (WMB.isWritingBlock?.(document.activeElement)) {
      return dom.setDirectText(el, text, { append });
    }
    const getSel = () => (typeof getSelection === 'function' ? getSelection() : document.getSelection?.() ?? null);
    if (!isSelectionInTarget()) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = getSel();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } catch { /* no selection API: the paste/exec paths are skipped below and the direct write is the fallback */ }
    }

    const selection = getSel();
    const selectAll = () => {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        if (append) range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch { /* noop */ }
    };

    const hadText = dom.getText(el).trim().length > 0;
    const before = dom.getText(el).length;
    const wantsBreaks = text.includes('\n');

    const paste = async (payload) => {
      if (!isTargetFocused() || !isSelectionInTarget() || WMB.isWritingBlock?.(document.activeElement)) return;
      selectAll();
      if (!append) { try { document.execCommand('delete'); } catch { /* noop */ } }
      const data = new DataTransfer();
      data.setData('text/plain', payload);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await WMB.sleep(90);
    };
    const landed = () => dom.getText(el).length > before && (!wantsBreaks || dom.getText(el).includes('\n'));

    if (pasteFirst) {
      // Pasted text keeps its line breaks in the editors that matter; a leading blank line separates it from a draft.
      try { await paste(append && hadText ? `\n\n${text}` : text); } catch { /* no clipboard support */ }
      if (landed()) return true;
    }

    // Double check focus and activeElement before execCommand
    if (isTargetFocused() && isSelectionInTarget() && !WMB.isWritingBlock?.(document.activeElement)) {
      try {
        selectAll();
        if (!append) document.execCommand('delete');
        const afterDelete = dom.getText(el).length;

        if (append && hadText) {
          document.execCommand('insertLineBreak');
          document.execCommand('insertLineBreak');
        }
        text.split('\n').forEach((line, i) => {
          if (i > 0) document.execCommand('insertLineBreak');
          if (line) document.execCommand('insertText', false, line);
        });
        await WMB.sleep(50);
        if (dom.getText(el).length > afterDelete) return true;
      } catch { /* no execCommand support: the direct write below is the fallback */ }
    }

    // Direct assignment fallback - 100% scoped to el
    return dom.setDirectText(el, text, { append });
  };
})();
