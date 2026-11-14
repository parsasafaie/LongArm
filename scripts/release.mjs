// One command for a release: bump the version in its three homes, regenerate the two generated files,
// and run the checks that must pass before anything is packed.
//
//   node scripts/release.mjs 0.0.2     # an explicit version
//   node scripts/release.mjs patch     # or minor / major, computed from the current one
//
// The version lives in `manifest.json`, `package.json` and `WMB.VERSION` (`content_scripts/utils.js`);
// `npm run check` fails when they disagree, so this is the only place that may write all three.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (command, args) => {
  const res = spawnSync(command, args, { stdio: 'inherit', cwd: root });
  if (res.status !== 0) process.exit(res.status ?? 1);
};

const manifestPath = join(root, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const current = manifest.version;

const arg = process.argv[2];
const bump = { major: 0, minor: 1, patch: 2 };
let version = arg;
// Object.hasOwn, not `in`: on the prototype chain ("constructor", "toString"…) `in` is true, the bump would
// run with a non-index key and compute a WRONG version (0.0.0) instead of failing with the usage error.
if (Object.hasOwn(bump, arg)) {
  const parts = current.split('.').map(Number);
  parts[bump[arg]] += 1;
  for (let i = bump[arg] + 1; i < parts.length; i += 1) parts[i] = 0;
  version = parts.join('.');
}
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('✘ give an explicit version (0.0.2) or one of: major, minor, patch');
  process.exit(1);
}
if (version === current) {
  console.error(`✘ ${version} is already the current version`);
  process.exit(1);
}

manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const utilsPath = join(root, 'content_scripts/utils.js');
writeFileSync(utilsPath, readFileSync(utilsPath, 'utf8').replace(/WMB\.VERSION = '[^']*'/, `WMB.VERSION = '${version}'`));

console.log(`✔ version bumped to ${version} (manifest.json, package.json, WMB.VERSION)`);
run('node', [join(root, 'scripts/build_constants.mjs')]);
run('node', [join(root, 'scripts/build_instructions.mjs')]);
run('node', [join(root, 'scripts/check.mjs')]);
console.log(`✔ ${version} is consistent and the generated files are fresh — now: npm test and npm run pack`);
