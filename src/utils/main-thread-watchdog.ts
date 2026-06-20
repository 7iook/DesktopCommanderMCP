/**
 * Main-thread stall watchdog (diagnostic only, opt-in via env DC_WATCHDOG=1).
 *
 * Why: desktop-commander intermittently pegs one core at ~100% and stops
 * responding to ALL tool calls until the process is respawned — a classic
 * single-thread event-loop block (catastrophic regex / O(n^2) loop) somewhere
 * in the hot output-processing path. A normal setInterval can't catch it
 * because the timer itself can't fire while the main thread is blocked.
 *
 * How: a Worker thread (its own thread) watches a heartbeat the main thread
 * bumps every 250ms via a SharedArrayBuffer. If the heartbeat stops advancing
 * for STALL_MS, the main thread is blocked — the Worker writes to stderr WHICH
 * hot-path function was entered last and on what input size. stderr is captured
 * by the MCP host (mcphub) so the evidence survives even though the main thread
 * is frozen. Zero behaviour change; markers are ~3 Atomics.store calls.
 */
import { Worker } from 'worker_threads';
import * as os from 'os';
import * as fsmod from 'fs';
import * as pathmod from 'path';

/** File the watchdog appends stall reports to (survives stderr/console routing). */
export const WATCHDOG_LOG = pathmod.join(os.homedir(), '.claude-server-commander', 'dc-watchdog.log');

// SharedArrayBuffer Int32 slots:
//   [0] heartbeat tick (main bumps ~4x/sec)
//   [1] last hot-path function code (see HOTPATH_NAMES)
//   [2] last hot-path input length
//   [3] hot-path nesting depth (inc on enter, dec on exit)
const SLOTS = 4;
let sab: Int32Array | null = null;
let enabled = false;

export const HOTPATH_NAMES: Record<number, string> = {
  0: '(none)',
  1: 'analyzeProcessState',
  2: 'cleanProcessOutput',
  3: 'appendToLineBuffer',
  4: 'filterCliXmlStream',
  5: 'stdout_data_cb',
  6: 'stderr_data_cb',
  7: 'getOutputSinceSnapshot',
  8: 'readOutputPaginated',
};

export function markHotPathEnter(code: number, inputLen: number): void {
  if (!sab) return;
  Atomics.store(sab, 1, code);
  Atomics.store(sab, 2, inputLen | 0);
  Atomics.add(sab, 3, 1);
}

export function markHotPathExit(): void {
  if (!sab) return;
  Atomics.sub(sab, 3, 1);
}

const WORKER_CODE = `
const { workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const sab = new Int32Array(workerData.buf);
const names = workerData.names;
const STALL_MS = workerData.stallMs;
const logFile = workerData.logFile;
let lastTick = Atomics.load(sab, 0);
let lastTickAt = Date.now();
let reported = false;
function emit(line) {
  try { process.stderr.write(line); } catch (e) {}
  try { fs.appendFileSync(logFile, line); } catch (e) {}
}
setInterval(() => {
  const tick = Atomics.load(sab, 0);
  const now = Date.now();
  if (tick !== lastTick) {
    lastTick = tick;
    lastTickAt = now;
    reported = false;
    return;
  }
  const stalledMs = now - lastTickAt;
  if (stalledMs >= STALL_MS && !reported) {
    reported = true;
    const code = Atomics.load(sab, 1);
    const len = Atomics.load(sab, 2);
    const depth = Atomics.load(sab, 3);
    const name = names[code] || ('code:' + code);
    emit(
      '[DC_WATCHDOG] ' + new Date().toISOString() + ' main thread STALLED ' + stalledMs +
      'ms+ — likely stuck in ' + name + ' (inputLen=' + len + ', hotpathDepth=' + depth +
      '). This is the function pegging the event loop.\\n'
    );
  }
}, 1000);
`;

export function startMainThreadWatchdog(): void {
  if (process.env.DC_WATCHDOG !== '1') return;
  const stallMs = Number(process.env.DC_WATCHDOG_STALL_MS) || 4000;

  const buf = new SharedArrayBuffer(SLOTS * Int32Array.BYTES_PER_ELEMENT);
  sab = new Int32Array(buf);
  enabled = true;

  // Ensure the log dir exists and record that the watchdog booted (proves it
  // loaded, with a timestamp, even if the host swallows child stderr).
  try {
    fsmod.mkdirSync(pathmod.dirname(WATCHDOG_LOG), { recursive: true });
    fsmod.appendFileSync(WATCHDOG_LOG, `[DC_WATCHDOG] ${new Date().toISOString()} enabled (stall threshold ${stallMs}ms, pid ${process.pid})\n`);
  } catch { /* best-effort */ }

  // Heartbeat: bump tick ~4x/sec. Won't fire while main thread is blocked —
  // that absence is exactly what the worker detects.
  setInterval(() => { if (sab) Atomics.add(sab, 0, 1); }, 250).unref();

  try {
    const w = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { buf, names: HOTPATH_NAMES, stallMs, logFile: WATCHDOG_LOG },
    });
    w.unref();
    w.on('error', () => { /* diagnostic only — never let it affect the server */ });
    process.stderr.write(`[DC_WATCHDOG] enabled (stall threshold ${stallMs}ms); log -> ${WATCHDOG_LOG}\n`);
  } catch (e) {
    process.stderr.write(`[DC_WATCHDOG] failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

export function isWatchdogEnabled(): boolean { return enabled; }
