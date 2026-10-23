/**
 * read_process_output's status block (decision card process-read-idle):
 * a process that prints only at the end but writes a file midway, a process
 * that exits at once without output, a process that stays silent, a wait
 * stopped by the per-call limit, output after the exit (forced close and
 * late lines), the evicted-session record, and the Python env defaults.
 * Calls the tool functions directly (dist), with a small wait ceiling.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startProcess, readProcessOutput, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { TerminalManager, MAX_COMPLETED_SESSIONS, MAX_EVICTED_TOMBSTONES } from '../dist/terminal-manager.js';
import { parsePsTime, descendantsOf, formatTreeLine, scanChangedFiles } from '../dist/utils/process-activity.js';
import { spawnSync } from 'child_process';
import { runIfMain, skip } from './helpers/run-if-main.js';

const textOf = (result) => result.content?.find((block) => block.type === 'text')?.text ?? '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const q = (p) => JSON.stringify(p);

function fixture(dir, name, source) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
}

async function start(command, cwd, extra = {}) {
  const result = await startProcess({ command, timeout_ms: 300, cwd, ...extra }, 300);
  const pid = result.structuredContent?.pid;
  assert(pid > 0, `start_process should start: ${textOf(result)}`);
  return pid;
}

/** Prints only at the end, writes its result file after ~1s (like review_spec.py) */
async function printsAtEndWritesFileMidway(dir) {
  const script = fixture(dir, 'late-printer.js',
    `const fs=require('fs');setTimeout(()=>fs.writeFileSync(${q(path.join(dir, 'review.md'))},'# review\\n'),800);` +
    `setTimeout(()=>{console.log('DONE review written');},4500);`);
  const pid = await start(`node ${q(script)}`, dir);
  await sleep(1200);
  const texts = [];
  for (let i = 0; i < 3; i++) texts.push(textOf(await readProcessOutput({ pid, timeout_ms: 400 }, 400)));
  for (const [i, text] of texts.entries()) {
    assert.match(text, /\[process\] state=running pid=\d+/, `read ${i + 1} should name the state: ${text}`);
    assert.match(text, new RegExp(`empty_reads_in_a_row=${i + 1}\\b`), `read ${i + 1} should count empty reads: ${text}`);
    assert.match(text, /since_last_output=never/, `no output yet: ${text}`);
  }
  assert(!texts[0].includes('[hint]'), `the first empty read gives no hint: ${texts[0]}`);
  assert.match(texts[1], /\[hint\] No new output for 2 reads/, `the second empty read suggests wait_until=exit: ${texts[1]}`);
  assert.match(texts[2], /\[hint\] 3 reads in a row returned no output[\s\S]*Stop polling[\s\S]*wait_until="exit"[\s\S]*force_terminate only if/, `the third says stop polling: ${texts[2]}`);
  assert.match(texts[2], /review\.md 9B @/, `the file written midway is listed: ${texts[2]}`);
  assert.match(texts[2], /files: changed_since_start=\d/, texts[2]);
  assert.match(texts[2], /tree: (\d+ procs|sampling)/, `the tree line is there: ${texts[2]}`);

  const final = textOf(await readProcessOutput({ pid, timeout_ms: 15000, wait_until: 'exit' }, 15000));
  assert.match(final, /DONE review written/, `wait_until=exit returns the final output: ${final}`);
  assert.match(final, /state=exited/, final);
  assert.match(final, /reason=exit until=exit/, final);
  assert.match(final, /output: integrity=complete late_lines=0/, final);
  assert.match(final, /empty_reads_in_a_row=0/, final);
  console.log('✓ prints at the end, writes a file midway: state, empty-read hints, candidate file, wait_until=exit');
}

async function fastExitWithoutOutput(dir) {
  const script = fixture(dir, 'quiet.js', `process.exit(0)`);
  const pid = await start(`node ${q(script)}`, dir);
  await sleep(500);
  const text = textOf(await readProcessOutput({ pid, timeout_ms: 2000 }, 2000));
  assert.match(text, /state=exited/, text);
  assert.match(text, /exit_code=0/, text);
  assert.match(text, /wait: requested=2000ms actual=\d+ms capped=false reason=(exit|none)/, text);
  assert.match(text, /\[hint\] The process exited with code 0 and wrote no output/, text);
  assert.match(text, /output: integrity=complete/, text);
  console.log('✓ fast exit without output: exited, exit code 0, no-output hint');
}

async function longSilentAndCapped(dir) {
  const script = fixture(dir, 'silent.js', `setTimeout(()=>{},60000)`);
  const pid = await start(`node ${q(script)}`, dir);
  try {
    // timeout_ms above the ceiling: the wait stops at the ceiling and says so
    const capped = textOf(await readProcessOutput({ pid, timeout_ms: 5000 }, 700));
    assert.match(capped, /wait: requested=5000ms actual=\d+ms capped=true\(cap=700\) reason=timeout/, capped);
    assert.match(capped, /\[hint\] This wait stopped at the per-call limit \(700ms\)/, capped);
    let text = '';
    for (let i = 0; i < 3; i++) text = textOf(await readProcessOutput({ pid, timeout_ms: 6000 }, 5000));
    assert.match(text, /empty_reads_in_a_row=4/, text);
    // Capped after repeated empty reads: no "call again" next to "stop polling"
    assert.match(text, /\[hint\] This wait stopped at the per-call limit \(5000ms\)[^\n]*keeps running\.\n/, text);
    assert(!text.includes('Call read_process_output again'), `no "call again" once the hints say stop polling: ${text}`);
    assert.match(text, /Stop polling/, text);
    // Sampled again shortly before the 4s wait ended, not when it began
    const age = Number(text.match(/sampled=([\d.]+)s_ago/)?.[1]);
    assert(age < 3, `the tree sample is from near the end of the wait, got ${age}s ago: ${text}`);
    assert.match(text, /tree: \d+ procs \([^)]*node/i, `the tree shows node after a full wait: ${text}`);
    assert.match(text, /cpu_delta=\+[\d.]+s over [\d.]+s|cpu_total=/, text);
    assert.match(text, /Low CPU does not mean it is stuck/, text);
  } finally {
    await forceTerminate({ pid });
  }
  console.log('✓ long silent process: capped wait reported, tree with CPU, stop-polling hint');
}

/** A process the command started in the background keeps the pipes open after the command exits */
async function outputAfterExit(dir) {
  const child = fixture(dir, 'late-child.js', `setTimeout(()=>console.log('late line'),3500)`);
  // cmd's `start /b` and sh's `&` hand their pipes to the background node
  const pid = process.platform === 'win32'
    ? await start(`start /b node ${q(child)} & echo parent done`, dir, { shell: 'cmd.exe' })
    : await start(`node ${q(child)} & echo parent done`, dir, { shell: '/bin/sh' });
  // Exited, pipes still held: a read that doesn't wait reports draining
  const deadline = Date.now() + 1500;
  let drainingSeen = '';
  while (Date.now() < deadline && !drainingSeen) {
    const text = textOf(await readProcessOutput({ pid, offset: -5 }, 100));
    if (/state=draining/.test(text)) drainingSeen = text;
    else await sleep(50);
  }
  assert(drainingSeen, 'the read between exit and close reports state=draining');
  assert.match(drainingSeen, /exit_code=0/, drainingSeen);
  assert.match(drainingSeen, /\[hint\] The process exited but its output pipes are still open/, drainingSeen);
  const first = textOf(await readProcessOutput({ pid, timeout_ms: 5000, wait_until: 'exit' }, 5000));
  assert.match(first, /parent done/, first);
  assert.match(first, /state=exited/, first);
  assert.match(first, /output: integrity=forced_close late_lines=0/, first);
  await sleep(3000);
  const later = textOf(await readProcessOutput({ pid, timeout_ms: 500 }, 500));
  assert.match(later, /late line/, later);
  assert.match(later, /late_lines=1/, later);
  assert.match(later, /\[hint\] 1 line\(s\) arrived after the output was finalized/, later);
  console.log('✓ output after the exit: forced close after the grace period, late lines appended and counted');
}

async function waitUntilExitIgnoresOutput(dir) {
  const script = fixture(dir, 'ticker.js', `let i=0;const t=setInterval(()=>{console.log('tick '+i);if(++i===10){clearInterval(t);}},200)`);
  const pid = await start(`node ${q(script)}`, dir);
  const text = textOf(await readProcessOutput({ pid, timeout_ms: 10000, wait_until: 'exit' }, 10000));
  assert.match(text, /tick 9/, `one read returns everything up to the exit: ${text}`);
  assert.match(text, /state=exited/, text);
  assert.match(text, /reason=exit until=exit/, text);
  // Measured up to the exit, not up to this read
  await sleep(1500);
  const later = textOf(await readProcessOutput({ pid, offset: -1 }, 100));
  const since = Number(later.match(/since_last_output=([\d.]+)s/)?.[1]);
  assert(since < 1, `since_last_output of an exited process stops at the exit, got ${since}s: ${later}`);
  console.log('✓ wait_until=exit: intermediate output does not end the wait; since_last_output stops at the exit');
}

async function stderrTailKeptAtExit(dir) {
  const script = fixture(dir, 'stderr-burst.js',
    `const line='e'.repeat(99)+'\\n';process.stderr.write(line.repeat(10000),()=>process.exit(1))`);
  const pid = await start(`node ${q(script)}`, dir);
  const text = textOf(await readProcessOutput({ pid, timeout_ms: 10000, wait_until: 'exit', length: 5 }, 10000));
  assert.match(text, /total=10000 \(stdout=0 stderr=10000\)/, `all 1MB of stderr is kept: ${text.slice(-600)}`);
  assert.match(text, /exit_code=1/, text.slice(-600));
  assert.match(text, /integrity=complete/, text.slice(-600));
  console.log('✓ 1MB of stderr written right before exit 1: all 10000 lines kept, integrity=complete');
}

async function observationStaysInBudget(dir) {
  const script = fixture(dir, 'silent2.js', `setTimeout(()=>{},30000)`);
  const pid = await start(`node ${q(script)}`, dir);
  try {
    const t0 = Date.now();
    // A tail read doesn't wait: what it costs is the observation
    const text = textOf(await readProcessOutput({ pid, offset: -5 }, 100));
    const elapsed = Date.now() - t0;
    assert.match(text, /tree: (sampling|\d+ procs)/, text);
    assert(elapsed < 300 + 250, `a read that doesn't wait spends at most ~300ms observing, took ${elapsed}ms`);
    console.log(`✓ observation budget: a non-waiting read took ${elapsed}ms`);
  } finally {
    await forceTerminate({ pid });
  }
}

async function pythonUnbuffered(dir) {
  const python = ['python', 'python3'].find((cmd) => spawnSync(cmd, ['--version'], { windowsHide: true }).status === 0);
  if (!python) return skip('Python unbuffered: no python on PATH');
  const script = fixture(dir, 'slow.py', `import time\nprint('first')\ntime.sleep(4)\nprint('second')\n`);
  const pid = await start(`${python} ${q(script)}`, dir);
  const text = textOf(await readProcessOutput({ pid, timeout_ms: 2500 }, 2500));
  assert.match(text, /first/, `print without flush shows up before the exit: ${text}`);
  assert.match(text, /state=running/, text);
  await readProcessOutput({ pid, timeout_ms: 10000, wait_until: 'exit' }, 10000);
  console.log('✓ Python: print without flush is readable while the script runs');
}

async function pythonEnvDefaults(dir) {
  const script = fixture(dir, 'env.js', `console.log('ENV', process.env.PYTHONUNBUFFERED, process.env.PYTHONIOENCODING)`);
  let pid = await start(`node ${q(script)}`, dir);
  let text = textOf(await readProcessOutput({ pid, timeout_ms: 5000, wait_until: 'exit', offset: 0 }, 5000));
  assert.match(text, /ENV 1 utf-8/, text);
  pid = await start(`node ${q(script)}`, dir, { env: { PYTHONUNBUFFERED: '0', PYTHONIOENCODING: 'gbk' } });
  text = textOf(await readProcessOutput({ pid, timeout_ms: 5000, wait_until: 'exit' }, 5000));
  assert.match(text, /ENV 0 gbk/, `values the caller set are kept: ${text}`);
  console.log('✓ Python env: PYTHONUNBUFFERED=1 / PYTHONIOENCODING=utf-8 unless already set');
}

function fakeCompleted(pid, readComplete) {
  return {
    session: { pid, outputLines: ['x', ''], evictedLines: 0, readComplete, streams: {}, startTime: new Date() },
    exitCode: 0, signal: null, endTime: new Date(),
  };
}

async function evictionKeepsTombstones() {
  const manager = new TerminalManager();
  for (let pid = 1; pid <= MAX_COMPLETED_SESSIONS; pid++) manager.completedSessions.set(pid, fakeCompleted(pid, pid === 50));
  manager.completedSessions.set(1000, fakeCompleted(1000, false));
  manager.retireCompletedSessions();
  assert.strictEqual(manager.completedSessions.size, MAX_COMPLETED_SESSIONS);
  assert(!manager.completedSessions.has(50), 'the fully read session goes first');
  assert(manager.completedSessions.has(1), 'an unread older session stays');
  assert.deepStrictEqual(
    (({ pid, exitCode, totalLines, readComplete }) => ({ pid, exitCode, totalLines, readComplete }))(manager.getEvictedSession(50)),
    { pid: 50, exitCode: 0, totalLines: 1, readComplete: true });
  for (let pid = 2000; pid < 2000 + MAX_EVICTED_TOMBSTONES + 10; pid++) {
    manager.completedSessions.set(pid, fakeCompleted(pid, false));
    manager.retireCompletedSessions();
  }
  assert.strictEqual(manager.evictedSessions.size, MAX_EVICTED_TOMBSTONES, 'tombstones are capped');
  console.log(`✓ eviction: fully read sessions first, ${MAX_EVICTED_TOMBSTONES} tombstones at most`);
}

async function helpers(dir) {
  assert.strictEqual(parsePsTime('00:01:02'), 62_000);
  assert.strictEqual(parsePsTime('1-02:00:00'), 26 * 3600_000);
  assert.strictEqual(parsePsTime('0:00.50'), 500);
  const all = [{ pid: 1, ppid: 0, name: 'a', cpuMs: 1 }, { pid: 2, ppid: 1, name: 'b', cpuMs: 2 }, { pid: 3, ppid: 2, name: 'c', cpuMs: 3 }, { pid: 4, ppid: 9, name: 'd', cpuMs: 4 }];
  assert.deepStrictEqual(descendantsOf(all, 1).map((p) => p.pid), [1, 2, 3]);
  const s1 = { at: 0, rootPid: 1, processes: descendantsOf(all, 1) };
  const s2 = { at: 2000, rootPid: 1, processes: s1.processes.map((p) => ({ ...p, cpuMs: p.cpuMs + 500 })) };
  assert.match(formatTreeLine(s1, s2, false, 2000), /cpu_delta=\+1\.50s over 2\.0s/);
  assert.strictEqual(formatTreeLine(undefined, undefined, true), 'tree: sampling (first sample not ready yet)');
  const sub = path.join(dir, 'scan'); fs.mkdirSync(path.join(sub, 'node_modules'), { recursive: true });
  const since = Date.now() - 1000;
  fs.writeFileSync(path.join(sub, 'new.txt'), 'n');
  fs.writeFileSync(path.join(sub, 'node_modules', 'skip.txt'), 's');
  const scan = await scanChangedFiles([sub], since, { deadline: Date.now() + 1000 });
  assert.deepStrictEqual(scan.files.map((f) => path.basename(f.path)), ['new.txt']);
  console.log('✓ helpers: ps time, descendants, CPU delta, file scan skips node_modules');
}

export default async function runTests() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-read-status-')));
  try {
    await helpers(dir);
    await evictionKeepsTombstones();
    await fastExitWithoutOutput(dir);
    await pythonEnvDefaults(dir);
    await pythonUnbuffered(dir);
    await waitUntilExitIgnoresOutput(dir);
    await stderrTailKeptAtExit(dir);
    await observationStaysInBudget(dir);
    await printsAtEndWritesFileMidway(dir);
    await longSilentAndCapped(dir);
    await outputAfterExit(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  return true;
}

runIfMain(import.meta.url, runTests);
