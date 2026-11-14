/**
 * utils.js — Utilities shared by all content scripts.
 * Defines the global `WMB` namespace (LongArm).
 */
(() => {
  'use strict';
  const WMB = (globalThis.WMB = globalThis.WMB || {});
  WMB.VERSION = '0.0.1';

  const nativeSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Message to the service worker (never throws). */
  WMB.bg = async (message) => {
    try { return await globalThis.chrome?.runtime?.sendMessage(message); } catch { return null; }
  };

  /** Is the tab hidden, covered by another window or unfocused? That is where Chrome/Brave throttle the page timers. */
  WMB.isBackground = () => typeof document !== 'undefined' && (document.hidden || !document.hasFocus());

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
   * @returns {{files:object[], build:(attached:boolean)=>string}}
   */
  // The default cap comes from the shared settings (content_scripts/constants.js, generated from shared/).
  WMB.planResult = (result, { server, name, status, maxChars = WMB.defaults.settings.maxResultChars }) => {
    const base = `${server}_${name}`.replace(/[^\w.-]+/g, '_').slice(0, 40);
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

  dom.getText = (el) => ('value' in el ? el.value : (el.innerText || el.textContent || ''));

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
  dom.setText = async (el, text, { append = true, pasteFirst = true } = {}) => {
    el.focus();

    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const previous = append ? el.value : '';
      setter.call(el, previous ? `${previous}\n\n${text}` : text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.setSelectionRange?.(el.value.length, el.value.length);
      return true;
    }

    const selection = getSelection();
    const selectAll = () => {
      const range = document.createRange();
      range.selectNodeContents(el);
      if (append) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    const hadText = dom.getText(el).trim().length > 0;
    const before = dom.getText(el).length;
    const wantsBreaks = text.includes('\n');

    const paste = async (payload) => {
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

    // Last resort: put the text in with a synthetic paste a second time, then assign it directly.
    try { await paste(append && hadText ? `\n\n${text}` : text); } catch { /* noop */ }
    if (landed()) return true;

    el.textContent = append && hadText ? `${dom.getText(el)}\n\n${text}` : text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return dom.getText(el).length > before;
  };
})();
