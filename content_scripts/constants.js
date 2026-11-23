/**
 * constants.js — the shared constants, for content scripts (GENERATED — do not edit).
 *
 * Source: shared/constants.js · written by `npm run constants` · checked by tests/test_constants.mjs.
 * It defines `WMB.defaults`, so utils.js can read the settings fallbacks at load and every content script
 * shares the same permissions, labels, statuses and timeouts. Loaded FIRST, before utils.js.
 */
(() => {
  'use strict';
  const WMB = (globalThis.WMB = globalThis.WMB || {});

  WMB.defaults = {
    /** DEFAULT_SETTINGS from shared/constants.js: also the shape core_bridge starts from. */
    settings: {
    "bridgeEnabled": true,
    "defaultPermission": "ask",
    "autoSend": true,
    "maxResultChars": 12000,
    "hideProtocol": true,
    "focusFallback": true,
    "autoEnableDiscovered": false,
    "controlPort": 8099
  },
    /** PERMISSIONS + PERMISSION_LABELS: the three states and their full wording. */
    permissions: [
    "allow",
    "ask",
    "deny"
  ],
    permissionLabels: {
    "allow": "Always allow",
    "ask": "Always ask",
    "deny": "Never allow"
  },
    /** RESULT_STATUSES: ok | error | rejected | format_error. */
    statuses: [
    "ok",
    "error",
    "rejected",
    "format_error"
  ],
    /** CONTENT_TIMEOUTS: tool > call on purpose (see shared/constants.js). */
    timeouts: {
    "tool": 150000,
    "deliver": 120000,
    "approval": 300000,
    "queue": 600000,
    "heartbeat": 10000
  },
    /** REPEAT_CALLS: the window in which an identical call is answered from the previous result. */
    repeat: {
    "windowMs": 15000,
    "max": 1
  },
  };
})();
