// Runs every JS test file in its own process with a hard timeout.
//
//   node scripts/run_tests.mjs   (part of `npm test`)
//
// A test that hangs used to stall the whole chain (the jsdom observers keep the event loop alive): the
// per-file timeout turns that into a failure with the file name, and a failing file always fails the run.
import { spawnSync } from 'node:child_process';

const TESTS = [
  'tests/test_manifest.mjs',
  'tests/test_adapters.mjs',
  'tests/test_constants.mjs',
  'tests/test_protocol.mjs',
  'tests/test_utils.mjs',
  'tests/test_parser.mjs',
  'tests/test_json_battery.mjs',
  'tests/test_prompt.mjs',
  'tests/test_background.mjs',
  'tests/test_hide_dom.mjs',
  'tests/test_registry.mjs',
  'tests/test_ws_client.mjs',
  'tests/test_ui_widget.mjs',
  'tests/test_batch_calls.mjs',
  'tests/test_lifecycle.mjs',
  'tests/test_input_management.mjs',
  'tests/test_chatgpt_observer.mjs',
  'tests/test_loop_guard.mjs',
  'tests/test_writing_block.mjs',
  'tests/test_result_replay.mjs',
  'tests/test_delivery_audit.mjs',
  'tests/test_conversation_isolation.mjs',
];

const TIMEOUT_MS = 180_000;
for (const test of TESTS) {
  const res = spawnSync(process.execPath, [test], { stdio: 'inherit', timeout: TIMEOUT_MS });
  if (res.error?.code === 'ETIMEDOUT') {
    console.error(`✘ ${test} timed out after ${TIMEOUT_MS / 1000}s`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`✘ ${test} failed (exit ${res.status ?? 'signal'})`);
    process.exit(res.status ?? 1);
  }
}
console.log(`✔ ${TESTS.length} JS test files passed`);
