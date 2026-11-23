/**
 * ui_widget.js — Floating panel inside the page (Shadow DOM, no style conflicts).
 *
 * Shows the state of the active MCPs and lets the user pick the permission of each
 * (always allow · always ask · never allow). With "ask" a modal dialog opens over
 * the page and requests APPROVAL before every tool (human-in-the-loop).
 *
 * It sends nothing into the chat: the instructions live in the Project / Skill the user installed, and the
 * extension only answers what the AI asks for (the tool list, tool results).
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value !== false && value != null) el.setAttribute(key, value);
    }
    for (const child of children.flat()) el.append(child?.nodeType ? child : document.createTextNode(child ?? ''));
    return el;
  };

  // The three states and their full wording come from the shared constants (no drift with the popup).
  const PERMS = WMB.defaults.permissions.map((perm) => [perm, WMB.defaults.permissionLabels[perm]]);
  /** Short labels: the segmented control is narrow. The full wording is the tooltip and the aria-label. */
  const PERM_SHORT = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };
  /** Ceiling of the approval dialog's argument preview: full under it, an honest count above it. */
  const ARGS_PREVIEW_CAP = 100_000;

  /** WMB.sleep keeps counting in a hidden tab; the native timer is only a fallback for a standalone load. */
  const sleep = (ms) => (typeof WMB.sleep === 'function' ? WMB.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms)));

  const CSS = `
    /* The theme lives on the host so the panel and the approval dialog share it. */
    :host {
      all: initial;
      --bg:#ffffff; --fg:#18181b; --muted:#71717a; --line:#e4e4e7; --accent:#18181b; --accent-fg:#fff;
      --ok:#15803d; --warn:#b45309; --err:#b91c1c;
    }
    @media (prefers-color-scheme: dark) {
      :host { --bg:#18181b; --fg:#fafafa; --muted:#a1a1aa; --line:#2e2e33; --accent:#fafafa; --accent-fg:#18181b;
              --ok:#4ade80; --warn:#fbbf24; --err:#f87171; }
    }
    .wrap {
      position: fixed; left: var(--x, 16px); top: var(--y, auto); bottom: var(--y, 16px); z-index: 2147483647;
      touch-action: none; user-select: none;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
      display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
    }
    .pill, .panel { background: var(--bg); border: 1px solid var(--line); box-shadow: 0 2px 8px rgba(0, 0, 0, .12); }
    .pill {
      display: flex; gap: 4px; align-items: center; padding: 4px 5px 4px 10px; border-radius: 8px;
      cursor: grab; color: inherit; font: inherit;
    }
    .pill-main {
      display: flex; gap: 7px; align-items: center; padding: 3px 4px 3px 0; border: 0; background: transparent;
      color: inherit; font: inherit; font-weight: 600; font-size: 12px; cursor: grab; white-space: nowrap;
    }

    .wrap.dragging .pill, .wrap.dragging .pill-main { cursor: grabbing; }
    .wrap.dragging { transition: none !important; }
    .wrap:not(.dragging) { transition: left .12s ease, top .12s ease; }
    .wrap.flip { flex-direction: column-reverse; }
    .wrap.flip .panel { margin-bottom: 4px; }
    @media (prefers-reduced-motion: reduce) { .wrap:not(.dragging) { transition: none; } }
    .panel { max-width: calc(100vw - 24px); max-height: min(70vh, calc(100vh - 40px)); }
    .pill.alert { border-color: var(--warn); }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
    .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
    .panel { width: 340px; max-height: 70vh; overflow: auto; border-radius: 8px; padding: 12px 14px; }
    .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .head strong { font-size: 13px; }
    .muted { color: var(--muted); font-size: 12px; }
    ul { list-style: none; margin: 6px 0; padding: 0; display: grid; gap: 6px; }
    li.srv { display: flex; gap: 8px; align-items: center; }
    .row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    button { font: inherit; cursor: pointer; border-radius: 6px; padding: 6px 10px; border: 1px solid var(--line); background: transparent; color: var(--fg); }
    button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 600; }
    button.danger { color: var(--err); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    /* Same 3-state control as the popup: short labels, the full wording in the tooltip. */
    .seg { display: flex; gap: 2px; padding: 2px; border-radius: 6px; background: rgba(127,127,127,.12); flex: none; }
    .seg button {
      padding: 3px 7px; border: 0; border-radius: 4px; background: transparent;
      color: var(--muted); font-size: 11px; font-weight: 600;
    }
    .seg button:hover { color: var(--fg); }
    .seg button.on { background: var(--accent); color: var(--accent-fg); }
    .seg button.on:hover { color: var(--accent-fg); }
    /* The approval dialog ("Ask"): a modal over the page, in the theme of the panel. */
    .overlay {
      position: fixed; inset: 0; z-index: 2147483646; display: flex; align-items: center; justify-content: center;
      padding: 16px; background: rgba(9,9,11,.45); backdrop-filter: blur(2px);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
    }
    .dialog {
      width: min(420px, 100%); max-height: min(80vh, 640px); overflow: auto; display: flex; flex-direction: column; gap: 6px;
      background: var(--bg); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 12px 34px rgba(0,0,0,.35);
      padding: 14px 16px;
    }
    .dialog .call { font-weight: 600; }
    .dialog:focus { outline: none; }
    .dialog pre {
      margin: 2px 0; padding: 8px; max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-word;
      background: rgba(127,127,127,.12); border-radius: 4px; font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
    }
    .log { font-size: 12px; color: var(--muted); }
    .log .err { color: var(--err); } .log .ok { color: var(--ok); }
    .perm { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: 10px; font-size: 12px; }
    li.srv .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); text-align: center; font-size: 11px; color: var(--muted); }
  `;

  class Widget {
    constructor(handlers) {
      this.handlers = handlers;
      this.model = { adapterName: '', servers: [], toolCount: 0, bridgeEnabled: true };
      this.logs = [];
      this.approvals = [];
      this.open = false;

      this.host = document.createElement('div');
      this.host.id = 'wmb-host';
      this.shadow = this.host.attachShadow({ mode: 'closed' });
      this.root = h('div', { class: 'wrap' });
      // The approval modal lives OUTSIDE the panel: it has to be visible (and usable) whatever the panel does.
      this.modalLayer = h('div', { class: 'modal-layer' });
      this.modalItem = null; // the pending approval the dialog is currently showing
      this.shadow.append(h('style', {}, CSS), this.root, this.modalLayer);
      document.documentElement.append(this.host);
      this.#initDrag();
      this.render();
    }

    // ═════════════════════════════ Window drag ═════════════════════════════
    // The pill is the handle. The position is remembered per URL in sessionStorage; double click resets it.
    #posKey() { return `wmb-widget-pos:${location.origin}${location.pathname}`; }

    #applyPosition(pos) {
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
        this.root.style.removeProperty('--x');
        this.root.style.removeProperty('--y');
        return;
      }
      // We store with left/top. Since the default is bottom, we switch to top so it stays stable while dragging.
      const w = this.root.getBoundingClientRect().width || 0;
      const hgt = this.root.getBoundingClientRect().height || 0;
      const x = Math.min(Math.max(0, pos.x), Math.max(0, window.innerWidth - w));
      const y = Math.min(Math.max(0, pos.y), Math.max(0, window.innerHeight - hgt));
      this.root.style.setProperty('--x', `${x}px`);
      this.root.style.setProperty('--y', `${y}px`);
      this.root.style.setProperty('bottom', 'auto');
    }

    #savePosition(x, y) {
      try { sessionStorage.setItem(this.#posKey(), JSON.stringify({ x, y })); } catch { /* storage unavailable */ }
    }

    #resetPosition() {
      try { sessionStorage.removeItem(this.#posKey()); } catch { /* noop */ }
      this.root.style.removeProperty('--x');
      this.root.style.removeProperty('--y');
      this.root.style.removeProperty('bottom');
    }

    // Pushes the whole set (pill + panel if open) inside the viewport.
    // Priority: keep it as close as possible to where it is, without going off-screen.
    #fitToViewport() {
      const r = this.root.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      let dx = 0, dy = 0;
      if (r.right > vw) dx -= (r.right - vw);
      if (r.left < 0) dx -= r.left; // if it fits entirely, leaves it at 0
      if (r.bottom > vh) dy -= (r.bottom - vh);
      if (r.top < 0) dy -= r.top;
      if (dx === 0 && dy === 0) return;
      const nx = r.left + dx;
      const ny = r.top + dy;
      this.root.style.setProperty('--x', `${Math.round(nx)}px`);
      this.root.style.setProperty('--y', `${Math.round(ny)}px`);
      this.root.style.setProperty('bottom', 'auto');
    }

    #initDrag() {
      // Restore the previous position (if any) as soon as there is layout.
      requestAnimationFrame(() => {
        try {
          const raw = sessionStorage.getItem(this.#posKey());
          if (raw) this.#applyPosition(JSON.parse(raw));
        } catch { /* ignore */ }
        // Re-clamp on window resize
        window.addEventListener('resize', () => {
          const raw = sessionStorage.getItem(this.#posKey());
          if (!raw) return;
          try { const pos = JSON.parse(raw); this.#applyPosition(pos); } catch { /* ignore */ }
        }, { passive: true });
      });

      // Event delegation: the handle is the pill (or its content).
      this.root.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
      // Double click on the pill → back to the default.
      this.root.addEventListener('dblclick', (e) => {
        if (e.target.closest('.pill')) this.#resetPosition();
      });
    }

    /** True while the trailing click of a drag is still being swallowed (so a drag never presses a button). */
    #justDragged() { return Boolean(this._suppressClickUntil && Date.now() < this._suppressClickUntil); }

    #onPointerDown(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      // Handle: the whole pill, or the panel head (except its buttons).
      let handle = e.target.closest('.pill');
      if (!handle) {
        const head = e.target.closest('.head[data-drag]');
        if (head && !e.target.closest('button, select, input, a, textarea')) handle = head;
      }
      if (!handle) return;
      e.preventDefault();
      e.stopPropagation();

      const rect = this.root.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const origX = rect.left, origY = rect.top;
      let moved = false;
      this.root.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch { /* old browsers */ }

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 4) return; // click threshold
        moved = true;
        this.root.style.setProperty('--x', `${Math.round(origX + dx)}px`);
        this.root.style.setProperty('--y', `${Math.round(origY + dy)}px`);
        this.root.style.setProperty('bottom', 'auto');
        // Re-fit to the viewport taking the whole set into account (pill+panel).
        this.#fitToViewport();
      };
      const onUp = () => {
        try { handle.releasePointerCapture(e.pointerId); } catch { /* noop */ }
        this.root.classList.remove('dragging');
        // Listeners on document: they do not depend on the pill still existing after a render().
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onUp, true);
        if (moved) {
          const r = this.root.getBoundingClientRect();
          this.#savePosition(r.left, r.top);
          this._suppressClickUntil = Date.now() + 250;
        }
      };
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
    }

    update(patch) { Object.assign(this.model, patch); this.render(); }

    log(kind, text) {
      this.logs.unshift({ kind, text, ts: new Date() });
      this.logs.length = Math.min(this.logs.length, 6);
      this.render();
    }

    /**
     * Asks the user for confirmation. Resolves `true` (run), `'always'` (run and always allow) or `false` (reject).
     * A dialog nobody answers resolves as a refusal after the shared approval timeout: the queue behind it must
     * never stall on a prompt the user has walked away from.
     */
    requestApproval(call, { timeoutMs = WMB.defaults.timeouts.approval } = {}) {
      return new Promise((resolve) => {
        const item = { call, resolve, done: false, timer: 0 };
        const timeout = Math.max(0, Number(timeoutMs) || 0);
        const expire = () => {
          if (item.done || !this.approvals.includes(item)) return;
          item.done = true;
          this.approvals = this.approvals.filter((a) => a !== item);
          this.log('err', `No answer for ${call.server} › ${call.name}: treated as a refusal.`);
          item.resolve(false);
          this.render();
        };
        this.approvals.push(item);
        // In a HIDDEN tab Chrome throttles page timers (down to once a minute after 5 minutes), so an
        // unanswered dialog could block the serial queue far beyond the approval timeout: there WMB.sleep
        // counts in the service worker. A visible tab keeps the cancellable native timer.
        if (timeout === 0) expire(); // the queue budget is already spent
        else if (typeof WMB.isBackground === 'function' && WMB.isBackground()) sleep(timeout).then(expire);
        else item.timer = setTimeout(expire, timeout);
        this.render(); // the pill shows the pending call; #renderApprovals opens the dialog
      });
    }

    // ───────────── Render ─────────────

    render(force = false) {
      const { servers, toolCount } = this.model;
      const pending = this.approvals.length;
      const activeLabel = !this.model.bridgeEnabled ? 'Bridge disabled' : servers.length
        ? `${servers.length} MCP · ${toolCount} tools`
        : 'No active MCPs';
      const allUp = servers.length > 0 && servers.every((s) => s.status === 'connected');
      const pill = h('div', {
        class: `pill${pending ? ' alert' : ''}`,
      },
      h('button', {
        class: 'pill-main',
        'aria-expanded': String(this.open),
        title: 'Open the panel: servers, permissions and the activity log',
        onclick: () => { if (this.#justDragged()) return; this.open = !this.open; this.render(); },
      },
      h('i', { class: `dot ${pending ? 'warn' : allUp && this.model.bridgeEnabled ? 'ok' : ''}` }),
      h('span', {}, pending ? `${pending} call${pending > 1 ? 's' : ''} pending approval` : activeLabel)));

      this.root.replaceChildren(...(this.open ? [this.#panel()] : []), pill);
      // On open (or if it ended up outside), adjust so nothing is left off-screen.
      if (this.open) requestAnimationFrame(() => this.#fitToViewport());
      this.#renderApprovals();
    }

    /**
     * The same 3-state control the popup uses: three short options, the full wording in the tooltip and the
     * accessible name. The panel is rebuilt on every update, so the current value is baked in when it is built.
     */
    #permSelect(value, onChange, label) {
      const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
      for (const [perm, text] of PERMS) {
        seg.append(h('button', {
          type: 'button',
          class: `seg-btn${perm === value ? ' on' : ''}`,
          title: text,
          role: 'radio',
          'aria-label': text,
          'aria-checked': String(perm === value),
          onclick: () => onChange(perm),
        }, PERM_SHORT[perm]));
      }
      return seg;
    }

    #panel() {
      const { servers, adapterName, bridgeEnabled } = this.model;
      const perms = new Set(servers.map((s) => s.permission));
      const common = perms.size === 1 ? [...perms][0] : 'mixed';

      return h('div', { class: 'panel', role: 'dialog', 'aria-label': 'LongArm' },
        h('div', { class: 'head', 'data-drag': '1', style: 'cursor: move;' },
          h('strong', {}, `LongArm · ${adapterName}`),
          h('button', { 'aria-label': 'Close', onclick: () => { this.open = false; this.render(true); } }, '✕')),

        servers.length
          ? h('ul', {}, servers.map((s) => h('li', { class: 'srv' },
            h('i', { class: `dot ${s.status === 'connected' ? 'ok' : s.status === 'connecting' ? 'warn' : ''}` }),
            h('span', { class: 'grow' }, s.name, h('span', { class: 'muted' }, s.permission === 'deny' ? ' · blocked' : s.status === 'connected' ? ` · ${s.toolCount} tools` : ' · disconnected')),
            this.#permSelect(s.permission, (value) => this.handlers.onSetPermission(s.id, value), `Permission for ${s.name}`))))
          : h('p', { class: 'muted' }, 'Open the extension icon and enable an MCP server.'),

        servers.length > 1
          ? h('div', { class: 'perm' }, h('strong', {}, 'All MCPs'),
            this.#permSelect(common, (value) => this.handlers.onSetPermission(null, value), 'Permission for all MCPs'))
          : null,

        h('p', { class: 'muted' }, 'The AI learns the rules from the Project/Skill you installed and asks for the tool list itself with a list_tools call. The extension writes nothing into the conversation.'),

        h('div', { class: 'row' },
          h('button', { class: bridgeEnabled ? 'danger' : 'primary', onclick: () => this.handlers.onToggleBridge(!bridgeEnabled) },
            bridgeEnabled ? 'Disable bridge' : 'Enable bridge'),
          h('button', { onclick: () => this.handlers.onRefresh() }, 'Refresh')),

        this.logs.length
          ? h('ul', { class: 'log' }, this.logs.map((l) => h('li', { class: l.kind },
            `${l.ts.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${l.text}`)))
          : null,

        // The build id is a hash of the installable text: it tells which text this copy expects installed, and
        // it is what the stale-page notice compares, so "which version am I running?" is answerable from here.
        h('div', { class: 'foot' }, h('div', {}, `LongArm v${WMB.VERSION}${typeof WMB.buildSignature === 'function' ? ` · build ${WMB.buildSignature()}` : ''}`)));
    }

    // ───────────── The approval dialog (permission «ask») ─────────────
    // A call is waiting: a modal over the page, in the same theme as the panel, showing exactly what would run.
    // Nothing is run until a button is pressed; Escape closes it as a refusal. It is rebuilt only when the
    // pending call changes, so an update (a log line, the heartbeat) never steals the focus mid-read.
    #renderApprovals() {
      const item = this.approvals[0] ?? null;
      if (item === this.modalItem) return;
      this.modalItem = item;
      if (!item) {
        this.modalLayer.replaceChildren();
        return;
      }
      const { call } = item;
      const decide = (value) => {
        if (item.done) return;
        item.done = true; // the user answered: the approval timeout has nothing left to do
        clearTimeout(item.timer);
        this.approvals = this.approvals.filter((a) => a !== item);
        item.resolve(value);
        this.render(); // the dialog closes; the pill goes back to the server state
      };
      // The user approves what they SEE: the arguments go in FULL (the pre scrolls). Only a pathological
      // payload is capped, and the cap says so — it never hides the rest silently.
      let args = JSON.stringify(call.arguments ?? {}, null, 2);
      if (args.length > ARGS_PREVIEW_CAP) args = `${args.slice(0, ARGS_PREVIEW_CAP)}\n… (+${args.length - ARGS_PREVIEW_CAP} characters not shown)`;
      const buttons = [
        h('button', { class: 'primary', onclick: () => decide(true) }, 'Run'),
        h('button', { onclick: () => decide('always') }, 'Always allow'),
        h('button', { class: 'danger', onclick: () => decide(false) }, 'Reject'),
      ];
      const dialog = h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'wmb-approval-title', tabindex: '-1' },
        h('strong', { id: 'wmb-approval-title' }, 'The AI wants to run a tool'),
        h('div', { class: 'call' }, `${call.server} › ${call.name}`),
        h('pre', {}, args),
        h('div', { class: 'row' }, ...buttons));
      const overlay = h('div', {
        class: 'overlay',
        // Escape refuses (the safe answer) and Tab cycles inside the dialog: the page behind never sees the keys.
        onkeydown: (e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); decide(false); return; }
          if (e.key !== 'Tab') return;
          e.preventDefault();
          const index = buttons.indexOf(this.shadow.activeElement);
          const step = e.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index === -1 || index === buttons.length - 1 ? 0 : index + 1);
          buttons[step].focus();
        },
      }, dialog);
      this.modalLayer.replaceChildren(overlay);
      // Focus the dialog itself, not a button: Enter alone must never approve a call.
      requestAnimationFrame(() => dialog.focus({ preventScroll: true }));
    }
  }

  WMB.Widget = Widget;
})();
