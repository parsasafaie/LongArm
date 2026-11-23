/**
 * mcp_parser.js - Lenient MCP call parser.
 *
 * Defines the public `WMB.extractMcpCalls` — the reading every caller wants — on top of the basic reader in
 * utils.js (`WMB.scanCallsText`, valid JSON only). The layers:
 *   0. Checks    : whitespace and HTML entities a renderer may have introduced (WMB.normalizeAiText).
 *   0b. Backslashes: the backslashes a Markdown renderer ate, doubled per string BEFORE anything parses —
 *                 without it the strict layer would decode `C:\new` as `C:<newline>ew` (a valid JSON escape!).
 *   1. Strict   (utils.js): valid JSON with {"mcp_call": {...}}.
 *   2. Repaired : fixes in the text the typical AI mistakes (stray backslashes from Windows paths, real line
 *                 breaks inside texts, unescaped inner quotes, curly quotes, trailing commas) and re-reads the JSON.
 *   3. Flags    : if the JSON is still broken, it looks for the server / name / arguments "flags" separately and, with the
 *                 tool schema, extracts each argument by its name. It is only accepted when the server and the
 *                 tool exist among the active MCPs (avoids false positives).
 * If there is call intent but nothing can be read, WMB.looksMalformed() detects it and WMB.formatCallError()
 * builds the notice returned to the AI with the exact reason (the AI used to be left waiting).
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB || WMB.extractMcpCalls) return; // already defined (the script is loaded once in the manifest)
  const scanCallsText = WMB.scanCallsText;

  const VALID_ESC = '"\\/bfnrt';
  const SMART_CLOSE = '\u201d';
  const slug = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isHex4 = (s, i) => /^[0-9a-fA-F]{4}$/.test(s.slice(i, i + 4));
  const nextSig = (s, i) => { let j = i; while (j < s.length && /\s/.test(s[j])) j += 1; return s[j]; };

  /**
   * Reads a JSON object/array starting at `start`, repairing the typical mistakes.
   * Returns { json, end } or null if it is incomplete (it does not self-close: a cut-off message is NOT a call).
   */
  function repairObject(text, start) {
    let out = '';
    let depth = 0;
    let inStr = false;
    let closers = '"';
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') {
          const n = text[i + 1];
          if (n !== undefined && (VALID_ESC.includes(n) || (n === 'u' && isHex4(text, i + 2)))) { out += ch + n; i += 1; }
          else out += '\\\\';
        } else if (closers.includes(ch)) {
          const nx = nextSig(text, i + 1);
          if (nx === undefined || ',}]:'.includes(nx)) { inStr = false; out += '"'; }
          else out += ch === '"' ? '\\"' : ch;
        } else if (ch === '\n') out += '\\n';
        else if (ch === '\r') { }
        else if (ch === '\t') out += '\\t';
        else if (ch < ' ') out += ' ';
        else out += ch;
        continue;
      }
      if (ch === '"' || ch === '\u201c') { inStr = true; closers = ch === '"' ? '"' : SMART_CLOSE + '"'; out += '"'; }
      else if (ch === '{' || ch === '[') { depth += 1; out += ch; }
      else if (ch === '}' || ch === ']') {
        out = out.replace(/,\s*$/, '') + ch;
        depth -= 1;
        if (depth === 0) return { json: out, end: i };
        if (depth < 0) return null;
      } else out += ch;
    }
    return null;
  }

  function normalizeCall(obj) {
    const c = obj && typeof obj === 'object' ? (obj.mcp_call ?? obj) : null;
    if (!c || typeof c !== 'object') return null;
    const name = c.name ?? c.tool ?? c.tool_name;
    if (typeof name !== 'string' || !name) return null;
    let args = c.arguments ?? c.args ?? c.parameters ?? c.input;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    return {
      server: typeof c.server === 'string' ? c.server : null,
      name,
      arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
    };
  }

  // The backslash pre-pass (layer 0b) and the repaired-JSON layer (2): both run the strict reader's failed
  // candidates through repairObject, and the pre-pass doubles what Markdown ate BEFORE anything parses.
  const DRIVE_PATH = /[A-Za-z]:\\/;
  // A drive path TOKEN: `C:\Users\name`, `D:\a\b.txt`… It ends at whitespace or a quote. Only the backslash
  // runs INSIDE it are literal separators; a valid `\"` or `\n` elsewhere in the same string is left alone.
  const DRIVE_PATH_TOKEN = /[A-Za-z]:\\(?:[^\\\s"'\u201d]|\\.)*/g;
  function fixStringBackslashes(raw) {
    // A drive path ANYWHERE in the string (`dir C:\...`, `type C:\new\text.txt`): the backslashes in it are
    // literal separators — `\n` in `C:\new` would otherwise decode into a real line break and `\t` in `\text`
    // into a tab. ONLY the path token is normalized; escaped quotes/newlines elsewhere stay valid JSON.
    if (DRIVE_PATH.test(raw)) {
      return raw.replace(DRIVE_PATH_TOKEN, (token) => token.replace(/\\+/g, (run) => (run.length % 2 === 0 ? run : `${run}\\`)));
    }
    // No drive: only the escapes JSON would reject are doubled, so deliberate `\n`s survive untouched.
    return raw.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (match, valid) => (valid ? match : '\\\\'));
  }
  function repairBackslashes(text) {
    let out = ''; let i = 0;
    while (i < text.length) {
      if (text[i] !== '"') { out += text[i]; i += 1; continue; }
      let j = i + 1; let raw = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) { raw += text[j] + text[j + 1]; j += 2; }
        else { raw += text[j]; j += 1; }
      }
      out += '"' + fixStringBackslashes(raw) + '"';
      i = j + 1;
    }
    return out;
  }

  function repairedCalls(raw) {
    const calls = [];
    let from = 0;
    for (;;) {
      const at = raw.indexOf('mcp_call', from);
      if (at === -1) break;
      from = at + 8;
      const start = raw.lastIndexOf('{', at);
      if (start === -1) continue;
      const fixed = repairObject(raw, start);
      if (!fixed) continue;
      try {
        const call = normalizeCall(JSON.parse(fixed.json));
        if (call) { calls.push(call); from = fixed.end + 1; }
      } catch { /* falls through to layer 3 */ }
    }
    return calls;
  }

  // Layer 3: flags (server / name / arguments by pattern)
  const looseUnescape = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (m, g) => {
    if (g[0] === 'u') return String.fromCharCode(parseInt(g.slice(1), 16));
    return ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[g] ?? g;
  });

  function coerce(chunk, schema) {
    const c = chunk.trim();
    if (c[0] === '"' || c[0] === '\u201c') {
      const last = Math.max(c.lastIndexOf('"'), c.lastIndexOf(SMART_CLOSE));
      return looseUnescape(last > 0 ? c.slice(1, last) : c.slice(1));
    }
    if (c[0] === '{' || c[0] === '[') {
      const fixed = repairObject(c, 0);
      if (fixed) { try { return JSON.parse(fixed.json); } catch { /* plain text */ } }
    }
    const bare = c.replace(/[\s,}`]+$/, '');
    if (schema?.type === 'string') return bare;
    try { return JSON.parse(bare); } catch { return bare; }
  }

  function parseArgs(text, tool) {
    const t = text.trimStart();
    if (t[0] === '{') {
      const fixed = repairObject(t, 0);
      if (fixed) { try { const o = JSON.parse(fixed.json); if (o && typeof o === 'object') return o; } catch { /* by keys */ } }
    }
    const props = tool?.inputSchema?.properties ?? {};
    const keys = Object.keys(props);
    if (!keys.length) return {};
    const body = t.replace(/^\{/, '');
    const marks = [];
    for (const key of keys) {
      const m = new RegExp(`["'\\u201c]${escapeRe(key)}["'\\u201d]\\s*:\\s*`).exec(body);
      if (m) marks.push({ key, at: m.index, valueAt: m.index + m[0].length });
    }
    marks.sort((a, b) => a.at - b.at);
    const out = {};
    marks.forEach((m, i) => { out[m.key] = coerce(body.slice(m.valueAt, marks[i + 1]?.at ?? body.length), props[m.key]); });
    return out;
  }

  const ARGS_RE = /["']?(?:arguments|args|parameters|input)["']?\s*:\s*/i;

  function flagCalls(raw, tools) {
    if (!Array.isArray(tools) || !tools.length) return [];
    const marks = [];
    for (let at = raw.indexOf('mcp_call'); at !== -1; at = raw.indexOf('mcp_call', at + 8)) marks.push(at);
    const calls = [];
    marks.forEach((at, k) => {
      const seg = raw.slice(at, marks[k + 1] ?? raw.length);
      if (!/\}[\s`]*$/.test(seg)) return; // cut off: not a call
      const argsAt = seg.search(ARGS_RE);
      const head = argsAt === -1 ? seg : seg.slice(0, argsAt);
      const quoted = '["\\u201c]([^"\\u201d]+)["\\u201d]';
      const server = new RegExp(`["']?server["']?\\s*[:=]\\s*${quoted}`, 'i').exec(head)?.[1] ?? null;
      const name = new RegExp(`["']?(?:name|tool|tool_name)["']?\\s*[:=]\\s*${quoted}`, 'i').exec(head)?.[1] ?? null;
      if (!name) return;
      const tool = tools.find((t) => t.name === name && (!server || slug(t.server) === slug(server) || slug(t.serverLabel) === slug(server)));
      if (!tool) return;
      let args = {};
      if (argsAt !== -1) {
        const m = ARGS_RE.exec(seg.slice(argsAt));
        args = parseArgs(seg.slice(argsAt + m[0].length), tool);
      }
      calls.push({ server: tool.server, name, arguments: args });
    });
    return calls;
  }

  // Layer 3: lenient JSON5 / Python style reader (single quotes, unquoted keys, True/False/None, comments).
  const LOOSE_IDENT = /^[A-Za-z_$][\w$-]*/;
  const LOOSE_NUM = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
  const LOOSE_WORDS = { true: true, false: false, null: null, True: true, False: false, None: null, undefined: null };
  const OPEN_QUOTES = ['"', "'", '\u201c', '\u2018'];
  const SIMPLE_ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', "'": "'", '/': '/', '\\': '\\' };

  /** Reads a value starting at `start`. Returns { value, end } or null if it is incomplete or cannot be understood. */
  function parseLoose(text, start) {
    let i = start;
    const bad = () => { throw new SyntaxError('loose'); };
    const skip = () => {
      for (;;) {
        while (i < text.length && /\s/.test(text[i])) i += 1;
        if (text[i] === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; }
        else if (text[i] === '/' && text[i + 1] === '*') { const close = text.indexOf('*/', i + 2); if (close === -1) bad(); i = close + 2; }
        else return;
      }
    };
    const string = () => {
      const open = text[i];
      const closers = open === '\u201c' ? '\u201d"' : open === '\u2018' ? '\u2019\'' : open;
      i += 1;
      let out = '';
      while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
          const n = text[i + 1];
          if (n === undefined) bad();
          if (Object.hasOwn(SIMPLE_ESC, n)) { out += SIMPLE_ESC[n]; i += 2; }
          else if (n === 'u' && isHex4(text, i + 2)) { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; }
          else { out += `\\${n}`; i += 2; } // stray backslash (C:\Users): kept
          continue;
        }
        if (closers.includes(ch)) {
          const nx = nextSig(text, i + 1);
          if (nx === undefined || ',}]:'.includes(nx)) { i += 1; return out; }
          out += ch; // unescaped inner quote
        } else if (ch !== '\r') out += ch;
        i += 1;
      }
      return bad();
    };
    const value = () => {
      skip();
      const ch = text[i];
      if (ch === undefined) bad();
      if (ch === '{') return object();
      if (ch === '[') return array();
      if (OPEN_QUOTES.includes(ch)) return string();
      const num = LOOSE_NUM.exec(text.slice(i, i + 40));
      if (num) { i += num[0].length; return Number(num[0]); }
      const word = LOOSE_IDENT.exec(text.slice(i, i + 20));
      if (word && Object.hasOwn(LOOSE_WORDS, word[0])) { i += word[0].length; return LOOSE_WORDS[word[0]]; }
      return bad();
    };
    const object = () => {
      i += 1;
      const out = {};
      for (;;) {
        skip();
        if (text[i] === '}') { i += 1; return out; }
        let key;
        if (text[i] === undefined) bad();
        if (OPEN_QUOTES.includes(text[i])) key = string();
        else {
          const id = LOOSE_IDENT.exec(text.slice(i, i + 80));
          if (!id) bad();
          key = id[0];
          i += key.length;
        }
        skip();
        if (text[i] !== ':') bad();
        i += 1;
        const v = value();
        if (key !== '__proto__') out[key] = v;
        skip();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return out; }
        bad();
      }
    };
    const array = () => {
      i += 1;
      const out = [];
      for (;;) {
        skip();
        if (text[i] === ']') { i += 1; return out; }
        out.push(value());
        skip();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return out; }
        bad();
      }
    };
    try { const v = value(); return { value: v, end: i - 1 }; } catch { return null; }
  }

  function looseCalls(raw) {
    const calls = [];
    let from = 0;
    for (;;) {
      const at = raw.indexOf('mcp_call', from);
      if (at === -1) break;
      from = at + 8;
      const start = raw.lastIndexOf('{', at);
      if (start === -1) continue;
      const parsed = parseLoose(raw, start);
      if (!parsed?.value || typeof parsed.value !== 'object') continue;
      const call = normalizeCall(parsed.value);
      if (call) { calls.push(call); from = parsed.end + 1; }
    }
    return calls;
  }

  /** `"name": "run_command"` — an identifier-shaped tool name: a real attempt, not a quoted placeholder. */
  const INTENT_RE = /["']?(?:name|tool|tool_name)["']?\s*[:=]\s*["']([A-Za-z0-9_$-]+)["']/;
  const INTENT_GLOBAL_RE = new RegExp(INTENT_RE.source, 'g');

  /** The `mcp_call` blocks of a text, cut at the next marker: each segment is tried on its own. */
  function callSegments(raw) {
    const marks = [];
    for (let at = raw.indexOf('mcp_call'); at !== -1; at = raw.indexOf('mcp_call', at + 8)) marks.push(at);
    const segments = [];
    marks.forEach((at, k) => {
      const start = raw.lastIndexOf('{', at);
      if (start === -1) return;
      segments.push(raw.slice(start, marks[k + 1] ?? raw.length));
    });
    return segments;
  }

  /** Can this ONE segment be read by any layer? (the same order extractMcpCalls uses). */
  function readSegment(segment, tools) {
    if (scanCallsText(segment).length) return true;
    if (repairedCalls(segment).length) return true;
    if (looseCalls(segment).length) return true;
    return flagCalls(segment, tools).length > 0;
  }

  /**
   * The `mcp_call` blocks that show a real call intent (an identifier name) but cannot be read by ANY layer.
   * This is what made a mixed batch dangerous: one valid call made `extractMcpCalls` return early, so a
   * broken sibling vanished without a `format_error` and the AI waited for an answer that never came.
   * @returns {string[]} the raw segment of each unreadable block (empty when every attempt reads).
   */
  WMB.malformedCallBlocks = (rawText, tools = WMB.tools) => {
    const raw = WMB.normalizeAiText(rawText);
    return callSegments(raw).filter((segment) => INTENT_RE.test(segment) && !readSegment(segment, tools));
  };

  /** Cleans what renderers and AIs sneak into the text: zero-width characters, odd spaces and HTML entities. */
  WMB.normalizeAiText = (value) => {
    let raw = String(value ?? '').replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '').replace(/[\u00a0\u2028\u2029]/g, ' ');
    if (/&(?:quot|#34|#x22);/i.test(raw) && !raw.includes('"mcp_call"')) {
      raw = raw.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
    }
    return raw;
  };

  /** Extracts the MCP calls: backslash pre-pass, strict, repaired, lenient reading and, last, flags. */
  WMB.extractMcpCalls = (rawText, tools = WMB.tools) => {
    const raw = WMB.normalizeAiText(rawText);
    // The backslash pre-pass comes FIRST on purpose: without it the strict layer would happily parse
    // `C:\new` as `C:<newline>ew` (a valid JSON escape!) and run the wrong command.
    const fixed = repairBackslashes(raw);
    const strict = scanCallsText(fixed);
    if (!raw.includes('mcp_call')) return strict;
    if (!strict.length) {
      const repaired = repairedCalls(fixed);
      if (repaired.length) return repaired;
      const loose = looseCalls(raw);
      return loose.length ? loose : flagCalls(raw, tools);
    }
    // The strict layer found something, but a message may carry SEVERAL blocks: an early return used to
    // swallow a repairable/invalid sibling. Read every block on its own and merge (dedup by content).
    const segments = callSegments(fixed);
    if (segments.length < 2) return strict;
    // The strict layer's calls are the baseline. A call found again by a segment is the SAME call (not a
    // duplicate batch entry); only occurrences BEYOND the strict count are additions. This never loses a
    // strict call when a marker sits inside a string value, and never collapses a legitimate duplicate.
    const keyOf = (call) => JSON.stringify([call.server, call.name, call.arguments]);
    const remaining = new Map();
    for (const call of strict) remaining.set(keyOf(call), (remaining.get(keyOf(call)) ?? 0) + 1);
    const merged = [];
    for (const segment of segments) {
      let found = scanCallsText(segment);
      if (!found.length) found = repairedCalls(segment);
      if (!found.length) found = looseCalls(segment);
      if (!found.length) found = flagCalls(segment, tools);
      for (const call of found) {
        const key = keyOf(call);
        const left = remaining.get(key) ?? 0;
        if (left > 0) remaining.set(key, left - 1);
        merged.push(call);
      }
    }
    // Strict calls a segment could not reach (their marker was inside another value): keep them.
    for (const call of strict) {
      const key = keyOf(call);
      const left = remaining.get(key) ?? 0;
      if (left > 0) { remaining.set(key, left - 1); merged.push(call); }
    }
    return merged.length ? merged : strict;
  };

  /**
   * There is MCP call intent (mcp_call + a name flag) but nothing could be read. A text that only QUOTES the
   * format (a documented example with `<tool>` or a placeholder) is NOT intent: a real call names a real tool —
   * an identifier — so only an identifier-shaped name value counts as intent.
   */
  WMB.looksMalformed = (rawText) => {
    const raw = String(rawText);
    if (!raw.includes('mcp_call') || !raw.includes('{')) return false;
    if (!INTENT_RE.test(raw)) return false;
    // Some calls may be readable and one block broken: that broken block is still intent (it used to be
    // swallowed by the early return of the strict/repaired layers).
    if (WMB.extractMcpCalls(raw).length) return WMB.malformedCallBlocks(raw).length > 0;
    for (const m of raw.matchAll(INTENT_GLOBAL_RE)) {
      if (/^[A-Za-z0-9_$-]+$/.test(m[1])) return true;
    }
    return false;
  };

  /** Exact reason the block could not be read. */
  function diagnose(raw) {
    const at = raw.indexOf('mcp_call');
    const start = raw.lastIndexOf('{', at);
    if (start === -1) return 'the opening { brace is missing';
    const fixed = repairObject(raw, start);
    if (!fixed) return 'the block is incomplete or cut off (missing closing } braces or an unclosed quote)';
    const seg = raw.slice(start, fixed.end + 1);
    let msg;
    try { JSON.parse(seg); return 'the JSON is valid but "name" is missing, or the server/tool does not match the active MCPs'; } catch (e) { msg = String(e.message); }
    const pos = Number((/position (\d+)/.exec(msg) || [])[1]);
    const near = Number.isFinite(pos) ? seg.slice(Math.max(0, pos - 25), pos + 25).replace(/\s+/g, ' ') : '';
    let why = 'invalid JSON';
    if (/escape/i.test(msg)) why = 'invalid escape sequence (almost always a Windows path with "\\": use "/" or double the backslash)';
    else if (/control character|Unterminated/i.test(msg)) why = 'a real line break inside a text value: use \\n';
    else if (/[\u201c\u201d]/.test(seg)) why = 'curly quotes instead of straight quotes';
    else if (/,\s*[}\]]/.test(seg)) why = 'trailing comma before } or ]';
    else if (/Unexpected|Expected/i.test(msg)) why = 'an unescaped quote inside a text value, or malformed JSON';
    return near ? `${why} (near: ${near})` : why;
  }
  WMB.diagnoseMcp = diagnose;

  /** Message returned to the AI when its block could not be read. */
  WMB.formatCallError = (raw) => `[MCP_RESULT server="bridge" tool="mcp_call" status="format_error"]\nThis block was not executed: it could not be read. Reason: ${diagnose(String(raw))}.\nCalls in the SAME message that were readable may already have run: do not resend them. Resend ONLY this corrected block: ONE message, inside \`\`\`json, on ONE single line, with ONE call and nothing before or after it. Rules: paths with "/" (C:/Users/...), inner quotes as \\", line breaks as \\n, no comments, no trailing commas, no text inside the JSON. For long scripts, first write a file with a tool and then run it.\nFormat: {"mcp_call":{"server":"<server>","name":"<tool>","arguments":{}}}\n[/MCP_RESULT]`;
})();
