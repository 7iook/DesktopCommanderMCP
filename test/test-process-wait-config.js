/**
 * The ceiling on one blocking process wait is a fixed constant, not a config
 * value: timeout_ms is the only knob callers have. Checks that a wait the
 * ceiling ends answers before the client's request timeout, the ceiling the
 * product computes, that set_config_value refuses the old maxProcessWaitMs key
 * and get_config doesn't list it, and set_config_value's handling of number
 * fields (numeric strings stored as numbers, non-numbers rejected, null resets)
 * and of null on array fields (it clears them too; it was stored as ["null"],
 * which made "null" the only allowed folder).
 * A wait the ceiling ends answers with the same status line as before.
 * The tests change settings in the home, so they run only in a test home (the
 * runner's), and leave every setting they change as they found it.
 */
import assert from 'assert';
import os from 'os';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { configManager } from '../dist/config-manager.js';
import { MAX_PROCESS_WAIT_MS } from '../dist/config.js';
import { getProcessWaitLimit } from '../dist/terminal-manager.js';
import { getConfig, setConfigValue } from '../dist/tools/config.js';
import { validatePath } from '../dist/tools/filesystem.js';
import { startProcess, interactWithProcess, interactWithProcessLines, readProcessOutput, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

// A capped wait answers after MAX_PROCESS_WAIT_MS, and that answer still has to
// be built and delivered (through the remote device's relay, too) before the
// client gives up on the call: at the MCP SDK's default request timeout, which
// Claude Desktop and the remote device's own client use (-32001 "Request timed out").
const MIN_MARGIN_UNDER_CLIENT_TIMEOUT_MS = 10000;

async function testCeilingUnderClientTimeout() {
  console.log('\n--- Test 0: a capped wait answers before the client gives up ---');
  const margin = DEFAULT_REQUEST_TIMEOUT_MSEC - MAX_PROCESS_WAIT_MS;
  assert(margin >= MIN_MARGIN_UNDER_CLIENT_TIMEOUT_MS,
    `a wait capped at ${MAX_PROCESS_WAIT_MS}ms leaves ${margin}ms before the client's ${DEFAULT_REQUEST_TIMEOUT_MSEC}ms request timeout: ` +
    `the answer arrives after the client has given up (-32001); it needs at least ${MIN_MARGIN_UNDER_CLIENT_TIMEOUT_MS}ms`);
  console.log(`ok: ${margin}ms margin under the SDK's ${DEFAULT_REQUEST_TIMEOUT_MSEC}ms request timeout`);
}

async function testFixedCeiling() {
  console.log('\n--- Test 1: the wait ceiling is the fixed constant ---');
  assert.strictEqual(MAX_PROCESS_WAIT_MS, 50000);
  assert.deepStrictEqual(getProcessWaitLimit(MAX_PROCESS_WAIT_MS * 5),
    { waitMs: MAX_PROCESS_WAIT_MS, capMs: MAX_PROCESS_WAIT_MS, capped: true });
  assert.deepStrictEqual(getProcessWaitLimit(1000),
    { waitMs: 1000, capMs: MAX_PROCESS_WAIT_MS, capped: false });
  assert.deepStrictEqual(getProcessWaitLimit(MAX_PROCESS_WAIT_MS),
    { waitMs: MAX_PROCESS_WAIT_MS, capMs: MAX_PROCESS_WAIT_MS, capped: false });
  console.log(`ok: min(timeout_ms, ${MAX_PROCESS_WAIT_MS}ms)`);
}

async function testNotConfigurable() {
  console.log('\n--- Test 2: maxProcessWaitMs is not a config key ---');
  const response = await setConfigValue({ key: 'maxProcessWaitMs', value: 5000 });
  assert.strictEqual(response.isError, true);
  assert.match(response.content[0].text, /not configurable/);
  assert.strictEqual(await configManager.getValue('maxProcessWaitMs'), undefined);
  const keys = (await getConfig()).structuredContent.entries.map((entry) => entry.key);
  assert(!keys.includes('maxProcessWaitMs'), `get_config must not list it, got: ${keys.join(', ')}`);
  console.log('ok: set_config_value refuses it, get_config does not list it');
}

async function testNumberFields() {
  console.log('\n--- Test 3: set_config_value number fields ---');
  const key = 'fileReadLineLimit';
  const before = await configManager.getValue(key);
  try {
    let response = await setConfigValue({ key, value: '250' });
    assert.notStrictEqual(response.isError, true, response.content?.[0]?.text);
    assert.strictEqual(await configManager.getValue(key), 250);

    response = await setConfigValue({ key, value: 'many' });
    assert.strictEqual(response.isError, true);
    assert.match(response.content[0].text, /must be a number/);
    assert.strictEqual(await configManager.getValue(key), 250, 'a rejected value must not change the stored one');

    response = await setConfigValue({ key, value: null });
    assert.notStrictEqual(response.isError, true, response.content?.[0]?.text);
    assert.strictEqual(await configManager.getValue(key), null);
  } finally {
    await configManager.setValue(key, before);
  }
  console.log('ok: "250" stored as 250, "many" rejected, null clears it');
}

async function testNullOnArrayFields() {
  console.log('\n--- Test 3b: set_config_value null on array fields ---');
  for (const key of ['allowedDirectories', 'blockedCommands']) {
    const before = await configManager.getValue(key);
    try {
      const response = await setConfigValue({ key, value: null });
      assert.notStrictEqual(response.isError, true, response.content?.[0]?.text);
      assert.strictEqual(await configManager.getValue(key), null,
        `null should clear ${key}, got ${JSON.stringify(await configManager.getValue(key))}: ${response.content[0].text.split('\n')[0]}`);
      if (key === 'allowedDirectories') {
        // Cleared, the allowed folders are what they are when never set: the home folder
        await validatePath(os.homedir()).catch((error) => assert.fail(`the home folder should be allowed again: ${error.message}`));
      }
    } finally {
      await configManager.setValue(key, before);
    }
  }
  console.log('ok: null clears allowedDirectories and blockedCommands');
}

async function testCappedWaitAnswers() {
  console.log('\n--- Test 4: a wait the ceiling ends answers as before ---');
  // A small ceiling stands in for MAX_PROCESS_WAIT_MS so the test doesn't wait a minute
  const CAP_MS = 300;
  const started = await startProcess({ command: 'node -e "setTimeout(() => {}, 3000)"', timeout_ms: 5000 }, CAP_MS);
  const pid = started.structuredContent?.pid;
  assert.ok(pid > 0, `start_process should start node, got: ${started.content[0].text}`);
  try {
    assert.strictEqual(started.structuredContent.waitCapped, true, started.content[0].text);
    assert.ok(started.content[0].text.endsWith('\n⏳ Process is running. Use read_process_output to get more output.'),
      `start_process should end with the old status line, got: ${started.content[0].text}`);
  } finally {
    await forceTerminate({ pid });
  }

  const repl = await startProcess({ command: 'node -i', timeout_ms: 5000 });
  const replPid = repl.structuredContent?.pid;
  assert.ok(replPid > 0, `start_process should start the Node.js REPL, got: ${repl.content[0].text}`);
  try {
    const busy = await interactWithProcess(
      { pid: replPid, input: 'const t = Date.now(); while (Date.now() - t < 2000) {}', timeout_ms: 5000 }, CAP_MS);
    assert.strictEqual(busy.structuredContent.waitCapped, true, busy.content[0].text);
    assert.ok(busy.content[0].text.endsWith('\n⏱️ Response may be incomplete (timeout reached)'),
      `interact_with_process should end with the old status line, got: ${busy.content[0].text}`);
  } finally {
    await forceTerminate({ pid: replPid });
  }
  console.log('ok: start_process and interact_with_process keep their old status lines');
}

async function testNodeLocalWaitsWithinTheCeiling() {
  console.log('\n--- Test 5: a node:local call waits within the ceiling too ---');
  // A small ceiling stands in for MAX_PROCESS_WAIT_MS; the script needs 6 s, the call allows 20 s
  const CAP_MS = 1500;
  const started = await startProcess({ command: 'node:local', timeout_ms: 20000 });
  const pid = Number(started.content[0].text.match(/PID (-?\d+)/)?.[1]);
  assert.ok(pid < 0, `start_process should start a node:local session, got: ${started.content[0].text}`);
  try {
    const result = await interactWithProcess(
      { pid, input: "await new Promise((resolve) => setTimeout(resolve, 6000)); console.log('done');", timeout_ms: 20000 }, CAP_MS);
    const text = result.content[0].text;
    assert.ok(!text.includes('done'),
      `a node:local script ran past the ${CAP_MS}ms wait ceiling (the call's timeout_ms was 20000) and answered: ${text}`);
  } finally {
    await forceTerminate({ pid });
  }
  console.log('ok: a node:local script ends at the wait ceiling');
}

async function testTailFollowWaitsWithinTheCeiling() {
  console.log('\n--- Test 6: a tail read with follow_ms waits within the ceiling too ---');
  // A small ceiling stands in for MAX_PROCESS_WAIT_MS; the silent process never ends the follow early
  const CAP_MS = 300;
  const FOLLOW_MS = 4000;
  const started = await startProcess({ command: 'node -e "setTimeout(() => {}, 8000)"', timeout_ms: 500 });
  const pid = started.structuredContent?.pid;
  assert.ok(pid > 0, `start_process should start node, got: ${started.content[0].text}`);
  try {
    const t0 = Date.now();
    await readProcessOutput({ pid, offset: -10, follow_ms: FOLLOW_MS }, CAP_MS);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < FOLLOW_MS / 2,
      `a tail read with follow_ms=${FOLLOW_MS} waited ${elapsed}ms, past the ${CAP_MS}ms wait ceiling`);
  } finally {
    await forceTerminate({ pid });
  }
  console.log('ok: follow_ms on a tail read ends at the wait ceiling');
}

async function testLineByLineWaitsWithinTheCeiling() {
  console.log('\n--- Test 7: interact_with_process_lines waits within the ceiling as a whole ---');
  // Each line may wait 2 s for a prompt that never comes; three of them must not add up past the ceiling
  const CAP_MS = 500;
  const started = await startProcess({ command: 'node -e "process.stdin.resume(); setTimeout(() => {}, 8000)"', timeout_ms: 500 });
  const pid = started.structuredContent?.pid;
  assert.ok(pid > 0, `start_process should start node, got: ${started.content[0].text}`);
  try {
    const t0 = Date.now();
    const result = await interactWithProcessLines({
      pid, fail_fast: false,
      lines: [{ input: 'a', timeout_ms: 2000 }, { input: 'b', timeout_ms: 2000 }, { input: 'c', timeout_ms: 2000 }],
    }, CAP_MS);
    const elapsed = Date.now() - t0;
    const text = result.content[0].text;
    assert.ok(elapsed < 1500, `three 2 s line waits took ${elapsed}ms, past the ${CAP_MS}ms wait ceiling: ${text}`);
    assert.match(text, /wait ceiling/, `the answer should say the ceiling stopped it, got: ${text}`);
  } finally {
    await forceTerminate({ pid });
  }
  console.log('ok: line-by-line waits end at the wait ceiling and say so');
}

async function testLineDelaysAndSettleWithinTheCeiling() {
  console.log('\n--- Test 8: delay_after_ms and settle_ms stay within the ceiling and say so ---');
  const CAP_MS = 120;
  const started = await startProcess({ command: 'node -e "process.stdin.resume(); setTimeout(() => {}, 8000)"', timeout_ms: 500 });
  const pid = started.structuredContent?.pid;
  assert.ok(pid > 0, `start_process should start node, got: ${started.content[0].text}`);
  try {
    // A fixed delay the ceiling cut short did not finish: not a success
    let t0 = Date.now();
    let result = await interactWithProcessLines({ pid, lines: [{ input: 'a', delay_after_ms: 3000 }] }, CAP_MS);
    let text = result.content[0].text;
    assert.ok(Date.now() - t0 < 1000, `a 3 s delay ran past the ${CAP_MS}ms ceiling: ${text}`);
    assert.strictEqual(result.isError, true, `a delay cut short must not report success: ${text}`);
    assert.match(text, /wait ceiling/, `the answer should say the ceiling cut the delay short: ${text}`);

    // The pause between lines is a wait too
    t0 = Date.now();
    result = await interactWithProcessLines({
      pid, settle_ms: 1500, lines: [{ input: 'b', delay_after_ms: 0 }, { input: 'c', delay_after_ms: 0 }],
    }, CAP_MS);
    text = result.content[0].text;
    assert.ok(Date.now() - t0 < 1000, `settle_ms 1500 ran past the ${CAP_MS}ms ceiling: ${text}`);
    assert.match(text, /wait ceiling/, `the answer should say the ceiling stopped it: ${text}`);

    // delay_after_ms 0 still completes at once
    result = await interactWithProcessLines({ pid, lines: [{ input: 'd', delay_after_ms: 0 }] }, CAP_MS);
    assert.notStrictEqual(result.isError, true, `delay_after_ms 0 should succeed: ${result.content[0].text}`);
  } finally {
    await forceTerminate({ pid });
  }
  console.log('ok: a cut-short delay is reported, settle_ms is bounded, delay 0 still succeeds');
}

// The settings these tests change: they must be left as they were found
const CHANGED_SETTINGS = ['fileReadLineLimit', 'allowedDirectories', 'blockedCommands'];

async function runAllTests() {
  if (!isTestHome()) {
    skip('process wait and config tests: they change settings in the home, so they run only through the test runner');
    return;
  }
  const before = await configManager.getConfig();
  await testCeilingUnderClientTimeout();
  await testFixedCeiling();
  await testNotConfigurable();
  await testNumberFields();
  await testNullOnArrayFields();
  await testCappedWaitAnswers();
  await testNodeLocalWaitsWithinTheCeiling();
  await testTailFollowWaitsWithinTheCeiling();
  await testLineByLineWaitsWithinTheCeiling();
  await testLineDelaysAndSettleWithinTheCeiling();
  const after = await configManager.getConfig();
  for (const key of CHANGED_SETTINGS) {
    assert.deepStrictEqual(after[key], before[key],
      `the tests left ${key} as ${JSON.stringify(after[key])}, not as they found it (${JSON.stringify(before[key])})`);
  }
  console.log('\n✅ process wait ceiling and config number tests passed');
}

runIfMain(import.meta.url, runAllTests);

export default runAllTests;
