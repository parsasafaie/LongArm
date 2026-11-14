// Writes content_scripts/constants.js — the copy of the shared constants a CONTENT SCRIPT can read.
//
//   npm run constants
//
// The extension has two module worlds, and only one of them can import: the background, the popup and the
// welcome page are ES modules and import `shared/constants.js` directly; content scripts are classic scripts
// injected by the manifest, so they cannot. This script generates the bridge between them: the same values,
// written as `WMB.defaults`, so the result statuses, the permission labels, the settings defaults and the
// controller's timeouts have exactly ONE source and cannot drift.
//
// `tests/test_constants.mjs` fails if the generated file is stale (run: npm run constants).
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTENT_TIMEOUTS, DEFAULT_SETTINGS, PERMISSIONS, PERMISSION_LABELS, REPEAT_CALLS, RESULT_STATUSES,
} from '../shared/constants.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const json = (value) => JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');

const body = `/**
 * constants.js — the shared constants, for content scripts (GENERATED — do not edit).
 *
 * Source: shared/constants.js · written by \`npm run constants\` · checked by tests/test_constants.mjs.
 * It defines \`WMB.defaults\`, so utils.js can read the settings fallbacks at load and every content script
 * shares the same permissions, labels, statuses and timeouts. Loaded FIRST, before utils.js.
 */
(() => {
  'use strict';
  const WMB = (globalThis.WMB = globalThis.WMB || {});

  WMB.defaults = {
    /** DEFAULT_SETTINGS from shared/constants.js: also the shape core_bridge starts from. */
    settings: ${json(DEFAULT_SETTINGS)},
    /** PERMISSIONS + PERMISSION_LABELS: the three states and their full wording. */
    permissions: ${json(PERMISSIONS)},
    permissionLabels: ${json(PERMISSION_LABELS)},
    /** RESULT_STATUSES: ok | error | rejected | format_error. */
    statuses: ${json(RESULT_STATUSES)},
    /** CONTENT_TIMEOUTS: tool > call on purpose (see shared/constants.js). */
    timeouts: ${json(CONTENT_TIMEOUTS)},
    /** REPEAT_CALLS: the window in which an identical call is answered from the previous result. */
    repeat: ${json(REPEAT_CALLS)},
  };
})();
`;

writeFileSync(`${root}/content_scripts/constants.js`, body);
console.log('✔ content_scripts/constants.js written (from shared/constants.js)');
