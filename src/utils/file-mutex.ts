/**
 * Per-absolute-path serial queue for file writes.
 *
 * Why this exists: AI agents routinely fire several edit_block / write_file
 * calls in parallel against the same file. The naive read-modify-write path
 * (performSearchReplace, writeFile) loses N-1 of those edits to a classic
 * lost-update race — every caller reads V1, each computes its own V2_x, and
 * the last writer wins. We reproduce this 4-out-of-5-lost in
 * `.race-repro.mjs`.
 *
 * The fix mirrors Kiro IDE's in-process edit tools: a Map<path, Promise>
 * queue. Each call await's the previous chain link for its target path
 * before doing its own R-M-W, then resolves its link so the next can run.
 *
 * Properties:
 *   - Same path: strictly serial (concurrency 1)
 *   - Different paths: fully concurrent (no global lock)
 *   - Failure isolation: previous failures don't block the next call
 *   - No memory leak: when a chain's tail completes, its entry is removed
 *   - Case-insensitive on Windows (path.resolve + toLowerCase) so
 *     `C:/foo` and `c:\foo` share a queue
 *
 * Limitation: only protects within THIS Node process. If multiple processes
 * write to the same file concurrently (e.g., user editor + desktop-commander),
 * we still rely on the OS — but inside one MCP server, all tool calls are
 * funneled through here.
 */

import path from 'path';

const chains = new Map<string, Promise<unknown>>();

/**
 * Canonical key for "these two path strings mean the same file".
 *
 * Exported because batch tools must bucket their entries with EXACTLY this
 * normalization: any grouping that disagrees with the lock's view splits one
 * file into several independent read-modify-write passes and re-introduces the
 * lost-update race the lock exists to prevent (see write_multiple_files /
 * edit_block_multiple grouping).
 */
export function normalizePathKey(absolutePath: string): string {
    const resolved = path.resolve(absolutePath);
    // Windows file system is case-insensitive (NTFS by default); Unix is sensitive.
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Run `fn` exclusively for the given absolute path. Concurrent calls with
 * the same (normalized) path are queued and executed in submission order.
 *
 * Returns whatever `fn` returns. Throws whatever `fn` throws.
 */
export async function withFileLock<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
    const key = normalizePathKey(absolutePath);
    const prev = chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(r => { release = r; });
    chains.set(key, next);
    try {
        // Don't propagate previous failures — the queue must keep moving even
        // if an earlier write threw.
        await prev.catch(() => {});
        return await fn();
    } finally {
        release();
        // If we're the tail of the chain, remove the entry to bound Map size.
        if (chains.get(key) === next) {
            chains.delete(key);
        }
    }
}

/** Test-only: reset all queued chains. Not exported through the public surface. */
export function _resetFileLocksForTesting(): void {
    chains.clear();
}
