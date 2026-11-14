// Tests the manifest layer: one canonical manifest, per-browser deltas as data, no drift.
//
// `scripts/manifest.mjs` reads the deltas from `scripts/browsers.json` (the same source `scripts/build.py`
// reads). The canonical `manifest.json` is the Chrome/Edge/Brave one. These checks make sure the Chrome build
// IS the canonical manifest, that an unknown browser fails instead of silently building Chrome, and that the
// canonical manifest is never mutated by a build.
import assert from 'node:assert/strict';
import { manifestFor, manifestJson, readCanonicalManifest, BROWSERS_LIST } from '../scripts/manifest.mjs';

const canonical = readCanonicalManifest();

// ───────────────────────── The browser list ─────────────────────────

assert.deepEqual(BROWSERS_LIST, ['chrome'], 'the browser this project ships');
assert.throws(() => manifestFor('safari'), /Unknown browser/, 'an unknown browser fails instead of silently building Chrome');

// ───────────────────────── Chrome is the canonical manifest, untouched ─────────────────────────

const chrome = manifestFor('chrome');
assert.deepEqual(chrome, canonical, 'the Chrome build IS the canonical manifest');
assert.equal(chrome.background.service_worker, 'background/background.js');
assert.equal(chrome.background.type, 'module');
assert.equal(chrome.minimum_chrome_version, canonical.minimum_chrome_version, 'the Chrome-only key stays');
assert.equal(manifestJson('chrome'), `${JSON.stringify(canonical, null, 2)}\n`, 'it serializes the way it is written to dist/');

// A build returns a copy: the canonical manifest is never mutated.
assert.notStrictEqual(chrome, canonical, 'the delta returns a copy: the canonical manifest is never mutated');
assert.equal(canonical.background.service_worker, 'background/background.js', 'the canonical manifest is left as it was on disk');

console.log('✔ test_manifest: all checks passed');
