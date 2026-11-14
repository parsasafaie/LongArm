// The ONE place that decides what each browser's manifest looks like.
//
// `manifest.json` at the root is the canonical manifest: the Chrome/Edge/Brave one, and the file both
// `chrome://extensions` and the Chrome Web Store take as it is. That is why it is not duplicated: two parallel
// manifests would drift (the permissions, the content scripts and the host patterns have to be identical), and
// one of them would silently win depending on who edited what.
//
// The per-browser DELTAS live as pure data in `scripts/browsers.json`, read by this module (the JS side) and
// by `scripts/build.py` (the no-Node builder) — one source, so the two builders can never drift. Everything a
// browser does not override is inherited from the canonical manifest.
import { readFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(new URL('./browsers.json', import.meta.url), 'utf8'));

/** Every browser this project can build for. */
export const BROWSERS_LIST = Object.keys(DATA.browsers);

/** Chrome-only manifest keys, dropped from the canonical manifest for any other browser. */
const CHROME_ONLY = DATA.chrome_only_keys;

/**
 * The canonical manifest, as it is on disk.
 * @returns {object}
 */
export function readCanonicalManifest() {
  return JSON.parse(readFileSync('manifest.json', 'utf8'));
}

/**
 * The manifest for one browser: the canonical one with that browser's delta applied, and the keys that only
 * make sense in Chrome dropped. The `version` is whatever the canonical manifest carries — this module does
 * NOT force or verify it: keeping it identical to `package.json` and `WMB.VERSION` is `scripts/check.mjs`'s
 * job (and the release writes all three).
 * @param {string} browser
 * @param {object} [canonical] the canonical manifest (read from disk when omitted)
 * @returns {object}
 */
export function manifestFor(browser, canonical = readCanonicalManifest()) {
  const delta = DATA.browsers[browser];
  if (!delta) throw new Error(`Unknown browser: ${browser} (known: ${BROWSERS_LIST.join(', ')})`);
  const manifest = structuredClone(canonical);
  if (browser !== 'chrome') for (const key of CHROME_ONLY) delete manifest[key];
  Object.assign(manifest, delta);
  return manifest;
}

/**
 * The manifest for one browser, serialized the way it is written to `dist/` (stable, two-space indent, trailing
 * newline), so the build and any test read exactly the same bytes.
 * @param {string} browser
 * @returns {string}
 */
export function manifestJson(browser) {
  return `${JSON.stringify(manifestFor(browser), null, 2)}\n`;
}
