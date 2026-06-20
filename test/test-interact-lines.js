// Test interact_with_process_lines (expect-style) + read_process_output follow_ms.
// Auto-discovered by run-all-tests.js (filename starts with "test").
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { terminalManager } from '../dist/terminal-manager.js';
import { interactWithProcessLines, readProcessOutput } from '../dist/tools/improved-process-tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT = path.join(__dirname, 'test_output');

const c = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nodeCmd = `node`; // on PATH; bare (a quoted exe path at PS statement start needs &)

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log(`${c.green}  ✓ ${msg}${c.reset}`); }
  else { console.log(`${c.red}  ✗ ${msg}${c.reset}`); failures++; }
}
function textOf(res) { return (res?.content?.[0]?.text) || ''; }

// --- fixtures ----------------------------------------------------------
const MULTI_PROMPT_FIXTURE = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const answers = [];
const total = 12;
let idx = 0;
process.stdout.write('PROMPT ' + (idx + 1) + ': ');
rl.on('line', (line) => {
  answers.push(line);
  idx++;
  if (idx >= total) {
    process.stdout.write('\\nRESULT:' + answers[total - 1] + '\\n');
    rl.close();
    process.exit(0);
  } else {
    process.stdout.write('\\nPROMPT ' + (idx + 1) + ': ');
  }
});
`;

// Prompts, accepts line 1 (emits a 2nd prompt), then goes silent forever
// so line 2's wait times out (for fail_fast test).
const HANG_FIXTURE = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write('ASK 1: ');
let seen = 0;
rl.on('line', () => {
  seen++;
  if (seen === 1) process.stdout.write('\\nASK 2: ');
  // line 2+ : never prints another prompt
});
setTimeout(() => {}, 60000);
`;

// Emits a line every 150ms (for follow_ms tail test).
const TICKER_FIXTURE = `
let n = 0;
const t = setInterval(() => {
  n++;
  process.stdout.write('TICK ' + n + '\\n');
  if (n >= 40) { clearInterval(t); process.exit(0); }
}, 150);
`;

async function writeFixture(name, body) {
  await fs.mkdir(OUT, { recursive: true });
  const p = path.join(OUT, name);
  await fs.writeFile(p, body, 'utf-8');
  return p;
}

// --- test 1: expect-style sequential, no misalignment ------------------
async function testSequentialPrompts() {
  console.log(`${c.cyan}Test 1: 11 skipped prompts + 12th = "local"${c.reset}`);
  const fx = await writeFixture('mp-fixture.cjs', MULTI_PROMPT_FIXTURE);
  const { pid } = await terminalManager.executeCommand(`${nodeCmd} "${fx}"`, 3000);
  assert(pid > 0, `started fixture pid=${pid}`);
  await sleep(500); // let first prompt flush

  const lines = [];
  for (let i = 0; i < 11; i++) lines.push({ input: '' });
  lines.push({ input: 'local' });

  const res = await interactWithProcessLines({ pid, lines, default_timeout_ms: 3000 });
  const out = textOf(res);
  assert(out.includes('Sent 12/12'), 'sent all 12 lines');
  assert(out.includes('RESULT:local'), 'fixture received "local" as the 12th answer (no misalignment)');
  if (!out.includes('RESULT:local')) console.log(out);
  terminalManager.forceTerminate(pid);
}

// --- test 2: custom wait_for regex -------------------------------------
async function testCustomWaitFor() {
  console.log(`${c.cyan}Test 2: custom wait_for regex${c.reset}`);
  const fx = await writeFixture('mp-fixture2.cjs', MULTI_PROMPT_FIXTURE);
  const { pid } = await terminalManager.executeCommand(`${nodeCmd} "${fx}"`, 3000);
  await sleep(500);
  // Prompt is "PROMPT N: " — match the literal "PROMPT" sentinel.
  const res = await interactWithProcessLines({
    pid,
    lines: [{ input: 'a' }, { input: 'b' }],
    default_wait_for: 'PROMPT \\d+: $',
    default_timeout_ms: 3000,
  });
  const out = textOf(res);
  assert(out.includes('Sent 2/2'), 'sent 2 lines using custom regex');
  assert(!out.includes('timeout'), 'custom regex matched the prompt (no timeout)');
  terminalManager.forceTerminate(pid);
}

// --- test 3: fail_fast on prompt that never appears --------------------
async function testFailFast() {
  console.log(`${c.cyan}Test 3: fail_fast on missing prompt${c.reset}`);
  const fx = await writeFixture('hang-fixture.cjs', HANG_FIXTURE);
  const { pid } = await terminalManager.executeCommand(`${nodeCmd} "${fx}"`, 2000);
  await sleep(500);
  const res = await interactWithProcessLines({
    pid,
    lines: [{ input: 'first' }, { input: 'second' }, { input: 'third' }],
    default_timeout_ms: 800,
    fail_fast: true,
  });
  const out = textOf(res);
  // line1 matches "ASK: "; line2 never gets a new prompt -> timeout -> stop.
  assert(out.includes('Sent 2/3'), `stopped after the timed-out line (got: ${out.split('\\n')[0]})`);
  assert(res.isError === true, 'aborted run is flagged isError');
  terminalManager.forceTerminate(pid);
}

// --- test 4: read_process_output follow_ms tails live output -----------
async function testFollowMs() {
  console.log(`${c.cyan}Test 4: read_process_output follow_ms${c.reset}`);
  const fx = await writeFixture('ticker-fixture.cjs', TICKER_FIXTURE);
  const { pid } = await terminalManager.executeCommand(`${nodeCmd} "${fx}"`, 1000);
  await sleep(400); // a few ticks accumulate

  // Tail without follow: snapshot now.
  const first = textOf(await readProcessOutput({ pid, offset: -5 }));
  const firstMax = Math.max(0, ...[...first.matchAll(/TICK (\d+)/g)].map(m => +m[1]));
  assert(firstMax > 0, `tail saw ticks (max=${firstMax})`);

  // follow_ms should block and pick up NEWER ticks.
  const t0 = Date.now();
  const second = textOf(await readProcessOutput({ pid, offset: -5, follow_ms: 1500 }));
  const elapsed = Date.now() - t0;
  const secondMax = Math.max(0, ...[...second.matchAll(/TICK (\d+)/g)].map(m => +m[1]));
  assert(secondMax > firstMax, `follow_ms captured newer ticks (${firstMax} -> ${secondMax})`);
  assert(elapsed < 1600, `returned within the follow window (${elapsed}ms)`);
  terminalManager.forceTerminate(pid);
}

// --- test 5: invalid pid is handled gracefully -------------------------
async function testInvalidPid() {
  console.log(`${c.cyan}Test 5: invalid pid${c.reset}`);
  const res = await interactWithProcessLines({ pid: 999999999, lines: [{ input: 'x' }] });
  assert(res.isError === true, 'no-session pid returns isError');
}

async function main() {
  console.log(`${c.blue}=== interact_with_process_lines + follow_ms ===${c.reset}`);
  try {
    await testSequentialPrompts();
    await testCustomWaitFor();
    await testFailFast();
    await testFollowMs();
    await testInvalidPid();
  } catch (err) {
    console.log(`${c.red}Unexpected error: ${err.stack || err}${c.reset}`);
    failures++;
  }
  if (failures > 0) {
    console.log(`${c.red}\n${failures} assertion(s) failed${c.reset}`);
    process.exit(1);
  }
  console.log(`${c.green}\nAll interact-lines tests passed${c.reset}`);
  process.exit(0);
}

main();
