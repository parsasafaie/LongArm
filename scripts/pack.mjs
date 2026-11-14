// Packs the extension into dist/longarm.zip (ready for the Chrome Web Store / GitHub Releases).
//
// The manifest that goes inside the package is written from `scripts/manifest.mjs` (same source as
// `scripts/build.py`), so the packaged copy can never carry a stale `version` or drift from the canonical root
// `manifest.json` — which stays exactly what it is: the manifest `chrome://extensions` loads while developing.
//
// The staging directory is rebuilt from scratch every time (rmSync + cpSync, not cp): a plain copy into an
// existing tree nests the sources one level deeper (`background/background/…`), and the zip would ship both.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { manifestFor } from './manifest.mjs';

const OUT = 'dist/longarm';
const DIRS = ['background', 'content_scripts', 'popup', 'shared', 'welcome', 'instructions'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const dir of DIRS) cpSync(dir, `${OUT}/${dir}`, { recursive: true });
if (existsSync('icons')) cpSync('icons', `${OUT}/icons`, { recursive: true }); // shipped only once the manifest declares some
const manifest = manifestFor('chrome');
writeFileSync(`${OUT}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

// The same checks build.py runs (its docstring promises "same validations"): nothing broken gets zipped.
const problems = [];
const background = manifest.background ?? {};
if (!background.service_worker) problems.push('background: Chrome needs a service worker');
for (const cs of manifest.content_scripts ?? []) {
  for (const js of cs.js ?? []) {
    if (!existsSync(`${OUT}/${js}`)) problems.push(`missing content script: ${js}`);
  }
}
for (const js of background.scripts ?? []) {
  if (!existsSync(`${OUT}/${js}`)) problems.push(`missing background script: ${js}`);
}
for (const icon of Object.values(manifest.icons ?? {})) {
  if (!existsSync(`${OUT}/${icon}`)) problems.push(`missing icon: ${icon}`);
}
if (!manifest.version) problems.push('no version');
if (problems.length) {
  for (const problem of problems) console.error(`✘ ${problem}`);
  process.exit(1);
}

rmSync('dist/longarm.zip', { force: true }); // zip UPDATES an existing archive: stale entries would survive
const zip = spawnSync('zip', ['-r', '../longarm.zip', 'manifest.json', ...DIRS, ...(existsSync(`${OUT}/icons`) ? ['icons'] : []), '-x', '*.DS_Store'], { cwd: OUT, stdio: 'inherit' });
process.exit(zip.status ?? 1);
