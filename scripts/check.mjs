// Checks the syntax of every .js in the project and validates the manifests.
//
// The canonical `manifest.json` at the root is what Chrome/Edge/Brave load while developing; the per-browser
// deltas live in `scripts/browsers.json` and are applied by the builders. Both are checked here, so a bad
// override fails in CI instead of at load time.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BROWSERS_LIST, manifestFor, readCanonicalManifest } from './manifest.mjs';

const skip = new Set(['node_modules', '.git', 'dist']);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(js|mjs)$/.test(name)) files.push(path);
  }
})('.');

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) { failed += 1; console.error(`✘ ${file}\n${res.stderr}`); }
}

/** Every file a manifest points at must exist on disk. */
function checkManifest(label, manifest) {
  for (const cs of manifest.content_scripts ?? []) {
    for (const js of cs.js ?? []) { try { statSync(js); } catch { failed += 1; console.error(`✘ ${label}: manifest references a nonexistent file: ${js}`); } }
  }
  const background = manifest.background ?? {};
  for (const file of [...(background.scripts ?? []), background.service_worker].filter(Boolean)) {
    try { statSync(file); } catch { failed += 1; console.error(`✘ ${label}: missing background script: ${file}`); }
  }
  // The action surface: the popup (and its icons) must exist too, or the toolbar button breaks.
  if (manifest.action?.default_popup) {
    try { statSync(manifest.action.default_popup); } catch { failed += 1; console.error(`✘ ${label}: missing popup: ${manifest.action.default_popup}`); }
  }
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) {
    try { statSync(icon); } catch { failed += 1; console.error(`✘ ${label}: missing action icon: ${icon}`); }
  }
  // The extension ships no icon of its own: only check the files when the manifest declares some.
  for (const icon of Object.values(manifest.icons ?? {})) { try { statSync(icon); } catch { failed += 1; console.error(`✘ ${label}: missing icon: ${icon}`); } }
  if (!manifest.version) { failed += 1; console.error(`✘ ${label}: no version`); }
}

const canonical = readCanonicalManifest();
checkManifest('manifest.json', canonical);
for (const browser of BROWSERS_LIST) checkManifest(`${browser} build`, manifestFor(browser, canonical));

// The three places the version lives must agree; the release bumps one number, not three.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const versionInCode = (readFileSync('content_scripts/utils.js', 'utf8').match(/WMB\.VERSION\s*=\s*'([^']+)'/) ?? [])[1];
if (versionInCode !== canonical.version) { failed += 1; console.error(`✘ version mismatch: manifest.json ${canonical.version} vs WMB.VERSION ${versionInCode}`); }
if (pkg.version !== canonical.version) { failed += 1; console.error(`✘ version mismatch: manifest.json ${canonical.version} vs package.json ${pkg.version}`); }

/** Every relative link in the docs must resolve (a file or a #heading): docs drift is the quiet kind of break. */
const docs = [];
(function walkDocs(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkDocs(path);
    else if (name.endsWith('.md')) docs.push(path);
  }
})('.');
const slug = (heading) => heading.trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');
const anchors = (path) => new Set(
  readFileSync(path, 'utf8').split('\n')
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => slug(line.replace(/^#{1,6}\s+/, ''))),
);
for (const file of docs) {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, ''); // links inside examples are not links
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:)/i.test(target)) continue;
    const at = target.indexOf('#');
    const path = at === -1 ? target : target.slice(0, at);
    const anchor = at === -1 ? null : target.slice(at + 1);
    const resolved = path ? join(dir, path) : file;
    if (!existsSync(resolved)) {
      failed += 1;
      console.error(`✘ ${file}: link target does not exist: ${target}`);
      continue;
    }
    if (anchor && resolved.endsWith('.md') && !anchors(resolved).has(anchor)) {
      failed += 1;
      console.error(`✘ ${file}: no heading matches #${anchor} in ${resolved}`);
    }
  }
}

if (failed) process.exit(1);
console.log(`✔ ${files.length} valid JS files; ${BROWSERS_LIST.length} manifests (canonical + ${BROWSERS_LIST.join('/')}) consistent at v${canonical.version}`);
