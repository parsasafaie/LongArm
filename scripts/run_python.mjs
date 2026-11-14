// Runs the Python tests with whatever interpreter this machine has.
//
//   node scripts/run_python.mjs        (part of `npm test`)
//
// `python` does not exist on every system and `python3` does not exist on Windows, so the interpreter is
// FOUND instead of assumed (python3 → python → py -3), and every test file runs under the same one.
import { spawnSync } from 'node:child_process';

const TESTS = [
  'tests/test_bridge.py',        // WebSocket <-> stdio end to end
  'tests/test_control.py',       // the control port
  'tests/test_launcher.py',      // the launcher: Start/Stop/Restart and the supervisor
  'tests/test_build.py',         // the no-Node builder's manifest layer (scripts/build.py)
  'mcp/terminal/test_mcp_server.py', // the built-in terminal server, spoken to over stdio
];

function findPython() {
  for (const candidate of [['python3'], ['python'], ['py', '-3']]) {
    const res = spawnSync(candidate[0], [...candidate.slice(1), '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], { stdio: 'ignore' });
    if (res.status === 0) return candidate;
  }
  console.error('✘ no Python 3.9+ found (looked for python3, python and `py -3`). Install it and try again.');
  process.exit(1);
}

const py = findPython();
for (const test of TESTS) {
  const res = spawnSync(py[0], [...py.slice(1), test], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`✘ ${test} failed`);
    process.exit(res.status ?? 1);
  }
}
console.log(`✔ ${TESTS.length} Python test files passed (with: ${py.join(' ')})`);
