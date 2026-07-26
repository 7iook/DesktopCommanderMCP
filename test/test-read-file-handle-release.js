/**
 * Regression test for upstream issues #476 / #502 (local report A-004):
 * On Windows, a truncated read (early `break` out of the readline loop) left the
 * underlying ReadStream alive, so the file descriptor stayed open. The file then
 * became undeletable / un-replaceable ("delete-pending", locked `.tmp*` files).
 *
 * The check below is platform-agnostic in shape but only *fails* where the OS
 * enforces mandatory locking (Windows). On POSIX, unlink succeeds even with an
 * open fd, so we additionally assert on the process' own open-handle count.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { readFileFromDisk } = await import('../dist/tools/filesystem.js');

/** Count fds this process holds for a given path (POSIX-only best effort). */
async function openHandleCount(targetPath) {
    if (process.platform === 'win32') return null;
    try {
        const fdDir = `/proc/${process.pid}/fd`;
        const entries = await fs.readdir(fdDir);
        let count = 0;
        for (const entry of entries) {
            try {
                const link = await fs.readlink(path.join(fdDir, entry));
                if (link === targetPath) count++;
            } catch { /* fd vanished mid-scan */ }
        }
        return count;
    } catch {
        return null;
    }
}

async function makeLargeFile(filePath, lineCount) {
    const lines = [];
    for (let i = 0; i < lineCount; i++) {
        lines.push(`line ${i} ${'x'.repeat(80)}`);
    }
    await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
}

/**
 * A truncated read must not keep the file locked.
 * Reproduces #476: 1978-line file read with the default 1000-line limit.
 */
async function testTruncatedReadReleasesHandle() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-handle-'));
    const filePath = path.join(dir, 'large-note-index.json');
    await makeLargeFile(filePath, 1978);

    const result = await readFileFromDisk(filePath, { offset: 0, length: 1000 });
    assert.ok(result.content.includes('line 0'), 'should have read the prefix');
    assert.ok(!result.content.includes('line 1500'), 'read should have been truncated');

    const handles = await openHandleCount(filePath);
    if (handles !== null) {
        assert.strictEqual(handles, 0, `expected 0 lingering fds, found ${handles}`);
    }

    // The real-world failure mode: atomic replace / delete is rejected while the
    // stream is still open. On Windows this throws EPERM or EBUSY.
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, 'replacement', 'utf-8');
    await fs.rename(tmpPath, filePath);
    await fs.rm(dir, { recursive: true, force: true });

    console.log('✓ truncated read releases its file handle');
}

/**
 * The estimated-position path (very large files + deep offset) breaks twice:
 * once after sampling, once after collecting `length` lines.
 */
async function testEstimatedPositionReadReleasesHandle() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-handle-est-'));
    const filePath = path.join(dir, 'huge.log');
    await makeLargeFile(filePath, 60000);

    const result = await readFileFromDisk(filePath, { offset: 50000, length: 20 });
    assert.ok(result.content.length > 0, 'should have read something');

    const handles = await openHandleCount(filePath);
    if (handles !== null) {
        assert.strictEqual(handles, 0, `expected 0 lingering fds, found ${handles}`);
    }

    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, 'replacement', 'utf-8');
    await fs.rename(tmpPath, filePath);
    await fs.rm(dir, { recursive: true, force: true });

    console.log('✓ estimated-position read releases its file handle');
}

/**
 * Repeated truncated reads of the same path must not accumulate handles
 * (A-004 observed the same file held twice).
 */
async function testRepeatedReadsDoNotAccumulateHandles() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-handle-rep-'));
    const filePath = path.join(dir, 'review.md');
    await makeLargeFile(filePath, 3000);

    for (let i = 0; i < 5; i++) {
        await readFileFromDisk(filePath, { offset: 0, length: 100 });
    }

    const handles = await openHandleCount(filePath);
    if (handles !== null) {
        assert.strictEqual(handles, 0, `expected 0 lingering fds, found ${handles}`);
    }

    await fs.rm(dir, { recursive: true, force: true });
    console.log('✓ repeated truncated reads do not accumulate handles');
}

export default async function runTests() {
    await testTruncatedReadReleasesHandle();
    await testEstimatedPositionReadReleasesHandle();
    await testRepeatedReadsDoNotAccumulateHandles();
    return true;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('test-read-file-handle-release.js')) {
    runTests()
        .then(() => console.log('All file-handle release tests passed'))
        .catch(err => { console.error('Test failed:', err); process.exit(1); });
}
