import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

/**
 * Observations read_process_output adds to its status block while a process
 * runs silently: what its process tree is doing, and which files changed under
 * the watched folders since it started. Both are clues, not facts about the
 * process: a file that changed may have been written by something else, and a
 * process tree with idle CPU may be waiting on the network. Both are bounded:
 * a sample that can't finish in time is reported as pending/partial instead of
 * delaying the read.
 */

export interface TreeProcess {
  pid: number;
  ppid: number;
  name: string;
  cpuMs: number | null;  // User+kernel CPU time since the process started; null when the OS didn't report it
}

export interface TreeSample {
  at: number;                 // When the sample was taken (ms epoch)
  rootPid: number;
  processes: TreeProcess[];   // The root and its descendants; empty when the root is gone
  error?: string;             // Set when the sample could not be taken
}

const SAMPLE_COMMAND_TIMEOUT_MS = 10_000;

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: SAMPLE_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout));
    });
  });
}

/** ps TIME: [[dd-]hh:]mm:ss[.xx] → ms */
export function parsePsTime(value: string): number | null {
  const match = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60_000 + Math.round(Number(seconds) * 1000);
}

async function listAllProcesses(): Promise<TreeProcess[]> {
  if (process.platform === 'win32') {
    const script =
      "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId,$_.ParentProcessId,([uint64]$_.KernelModeTime+[uint64]$_.UserModeTime),$_.Name }";
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return out.split(/\r?\n/).flatMap((line) => {
      const [pid, ppid, cpu100ns, ...name] = line.trim().split('|');
      if (!pid || !/^\d+$/.test(pid)) return [];
      const cpu = Number(cpu100ns);
      return [{ pid: Number(pid), ppid: Number(ppid), name: name.join('|'), cpuMs: Number.isFinite(cpu) ? Math.round(cpu / 10_000) : null }];
    });
  }
  const out = await run('ps', ['-A', '-o', 'pid=,ppid=,time=,comm=']);
  return out.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), cpuMs: parsePsTime(match[3]), name: path.basename(match[4]) }];
  });
}

/** The root and all its descendants, root first, then breadth-first */
export function descendantsOf(all: TreeProcess[], rootPid: number): TreeProcess[] {
  const byParent = new Map<number, TreeProcess[]>();
  for (const proc of all) {
    if (proc.pid === proc.ppid) continue;
    const siblings = byParent.get(proc.ppid) ?? [];
    siblings.push(proc);
    byParent.set(proc.ppid, siblings);
  }
  const root = all.find((proc) => proc.pid === rootPid);
  if (!root) return [];
  const result: TreeProcess[] = [root];
  const seen = new Set([rootPid]);
  for (let i = 0; i < result.length; i++) {
    for (const child of byParent.get(result[i].pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
    }
  }
  return result;
}

export async function sampleProcessTree(rootPid: number): Promise<TreeSample> {
  const at = Date.now();
  try {
    return { at, rootPid, processes: descendantsOf(await listAllProcesses(), rootPid) };
  } catch (error) {
    return { at, rootPid, processes: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Per-pid sampler: one sample in flight at a time, the last two kept so the
 * CPU used between them can be reported. read_process_output starts a sample
 * when its wait begins, so on Windows (Get-CimInstance takes ~0.5-1s) the
 * sample usually finishes during the wait instead of after it.
 */
class TreeSampler {
  private entries = new Map<number, { previous?: TreeSample; last?: TreeSample; inflight?: Promise<TreeSample> }>();

  start(pid: number): Promise<TreeSample> {
    const entry = this.entries.get(pid) ?? {};
    this.entries.set(pid, entry);
    if (!entry.inflight) {
      entry.inflight = sampleProcessTree(pid).then((sample) => {
        entry.inflight = undefined;
        // Keep failed samples too: an old successful pair is not current quiet evidence.
        entry.previous = entry.last;
        entry.last = sample;
        return sample;
      });
    }
    return entry.inflight;
  }

  /** The last two completed samples */
  latest(pid: number): { previous?: TreeSample; last?: TreeSample; pending: boolean } {
    const entry = this.entries.get(pid);
    return { previous: entry?.previous, last: entry?.last, pending: Boolean(entry?.inflight) };
  }

  forget(pid: number): void {
    this.entries.delete(pid);
  }
}

export const treeSampler = new TreeSampler();

/** Fraction of one CPU core that counts as observed activity. */
export const TREE_ACTIVITY_CPU_RATIO = 0.02;

export interface QuietActivity {
  lastActivityAt: number;
  sampledAt?: number;
  quietSince?: number;
  samples: number;
}

/** Advance session activity using completed observations only, never wall-clock silence alone. */
export function observeQuiet(activity: QuietActivity, previous: TreeSample | undefined, last: TreeSample | undefined,
  lastOutputAt: number, scan: FileScanResult | undefined): number | undefined {
  activity.lastActivityAt = Math.max(activity.lastActivityAt, lastOutputAt,
    ...((scan?.files ?? []).map(file => file.mtimeMs)));
  if (!previous || !last || last.at <= previous.at || last.error || previous.error) {
    activity.quietSince = undefined;
    activity.samples = 0;
    if (last) activity.lastActivityAt = Math.max(activity.lastActivityAt, last.at);
    return undefined;
  }
  if (activity.sampledAt !== last.at) {
    const before = new Map(previous.processes.map(proc => [proc.pid, proc.cpuMs]));
    let delta = 0;
    let known = last.processes.length > 0 && previous.processes.length > 0;
    for (const proc of last.processes) {
      const was = before.get(proc.pid);
      if (proc.cpuMs === null || was === null || was === undefined || proc.cpuMs < was) known = false;
      else delta += proc.cpuMs - was;
    }
    activity.sampledAt = last.at;
    if (!known || delta >= (last.at - previous.at) * TREE_ACTIVITY_CPU_RATIO) {
      activity.lastActivityAt = Math.max(activity.lastActivityAt, last.at);
      activity.quietSince = undefined;
      activity.samples = 0;
      return undefined;
    }
    activity.quietSince ??= previous.at;
    activity.samples++;
  }
  if (activity.quietSince === undefined) return undefined;
  return Math.max(0, last.at - Math.max(activity.quietSince, activity.lastActivityAt));
}

function totalCpu(sample: TreeSample): number | null {
  let total = 0;
  for (const proc of sample.processes) {
    if (proc.cpuMs === null) return null;
    total += proc.cpuMs;
  }
  return total;
}

/**
 * One status-block line: `tree: 3 procs (powershell.exe 100, python.exe 200, ...) cpu_delta=+1.20s over 50.1s`.
 * Only processes present in both samples count towards the delta, so a child
 * that exited between them doesn't make the delta negative.
 */
export function formatTreeLine(previous: TreeSample | undefined, last: TreeSample | undefined, pending: boolean, now: number = Date.now()): string {
  if (!last) return pending ? 'tree: sampling (first sample not ready yet)' : 'tree: unavailable';
  if (last.error) return 'tree: unavailable (sample failed; CPU unknown)';
  if (last.processes.length === 0) return 'tree: root process not found (it may have just exited)';
  const shown = last.processes.slice(0, 6).map((proc) => `${proc.name} ${proc.pid}`).join(', ');
  const more = last.processes.length > 6 ? `, +${last.processes.length - 6} more` : '';
  let cpu = 'cpu=baseline (first sample)';
  if (previous && previous.processes.length > 0) {
    const before = new Map(previous.processes.map((proc) => [proc.pid, proc.cpuMs]));
    let delta = 0;
    let known = true;
    for (const proc of last.processes) {
      const was = before.get(proc.pid);
      if (proc.cpuMs === null || was === null) { known = false; break; }
      if (was !== undefined) delta += proc.cpuMs - was;
    }
    const span = ((last.at - previous.at) / 1000).toFixed(1);
    cpu = known ? `cpu_delta=+${(Math.max(0, delta) / 1000).toFixed(2)}s over ${span}s` : 'cpu=unknown';
  } else if (totalCpu(last) !== null) {
    cpu = `cpu_total=${((totalCpu(last) ?? 0) / 1000).toFixed(2)}s (first sample, no delta yet)`;
  }
  const age = ((now - last.at) / 1000).toFixed(1);
  return `tree: ${last.processes.length} procs (${shown}${more}) ${cpu} sampled=${age}s_ago`;
}

export interface ChangedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface FileScanResult {
  files: ChangedFile[];   // Newest first
  scannedEntries: number;
  partial: boolean;       // Stopped early (deadline or entry budget)
}

const SKIPPED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.hg', '.svn']);

/**
 * Files under `roots` modified at or after `sinceMs`. Does not follow
 * symlinks, skips VCS / dependency folders, looks `maxDepth` levels deep,
 * and stops at `deadline` or after `maxEntries` directory entries (then `partial`).
 */
export async function scanChangedFiles(
  roots: string[],
  sinceMs: number,
  { deadline, maxDepth = 3, maxEntries = 5000, untilMs = Infinity }: { deadline: number; maxDepth?: number; maxEntries?: number; untilMs?: number }
): Promise<FileScanResult> {
  const files: ChangedFile[] = [];
  let scannedEntries = 0;
  let partial = false;
  const queue: Array<{ dir: string; depth: number }> = roots.map((dir) => ({ dir, depth: 0 }));
  while (queue.length > 0) {
    if (Date.now() >= deadline || scannedEntries >= maxEntries) { partial = true; break; }
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // A watched path may name a file
      if (depth === 0) {
        try {
          const stat = await fs.lstat(dir);
          if (stat.isFile() && stat.mtimeMs >= sinceMs && stat.mtimeMs <= untilMs) files.push({ path: dir, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // Missing: nothing changed there
        }
      }
      continue;
    }
    for (const entry of entries) {
      scannedEntries++;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 < maxDepth && !SKIPPED_DIRS.has(entry.name)) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (Date.now() >= deadline) { partial = true; break; }
      try {
        const stat = await fs.lstat(full);
        if (stat.mtimeMs >= sinceMs && stat.mtimeMs <= untilMs) files.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Gone or unreadable: not a candidate
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { files, scannedEntries, partial };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Status-block lines for a file scan (the first is `files: ...`) */
export function formatFileLines(scan: FileScanResult | undefined, watched: boolean, limit = 5): string[] {
  if (!watched) return ['files: not_watched'];
  if (!scan) return ['files: scan_unavailable'];
  const header = `files: changed_since_start=${scan.files.length}${scan.partial ? ' (partial: scan budget reached, there may be more)' : ''}`;
  const rows = scan.files.slice(0, limit).map((file) => `    ${file.path} ${formatSize(file.size)} @${formatClock(file.mtimeMs)}`);
  if (scan.files.length > limit) rows.push(`    ... ${scan.files.length - limit} more`);
  return [header, ...rows];
}
