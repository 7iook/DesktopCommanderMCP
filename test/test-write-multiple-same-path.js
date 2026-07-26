/**
 * Regression test for local report A-003:
 * `write_multiple_files` with several same-path entries (1 rewrite + N appends)
 * reported "8 succeeded, 0 failed" while only the first chunk reached disk.
 *
 * Verifies that same-path entries are applied in submission order and that
 * every reported success is actually durable.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import assert from 'assert';

const { handleWriteMultipleFiles } = await import('../dist/handlers/filesystem-handlers.js');
const { configManager } = await import('../dist/config-manager.js');

async function withAllowedDir(fn) {
    const original = await configManager.getConfig();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-wmf-'));
    try {
        await configManager.setValue('allowedDirectories', [dir, os.tmpdir()]);
        return await fn(dir);
    } finally {
        await configManager.setValue('allowedDirectories', original.allowedDirectories ?? []);
        await fs.rm(dir, { recursive: true, force: true });
    }
}

/** 1 rewrite + 7 appends on one path — the exact A-003 shape. */
async function testSamePathRewriteThenAppends() {
    await withAllowedDir(async (dir) => {
        const filePath = path.join(dir, 'report.md');

        const files = [{ path: filePath, content: 'block-0\n', mode: 'rewrite' }];
        for (let i = 1; i <= 7; i++) {
            files.push({ path: filePath, content: `block-${i}\n`, mode: 'append' });
        }

        const result = await handleWriteMultipleFiles({ files });
        const succeeded = result.structuredContent?.succeeded;
        assert.strictEqual(result.structuredContent?.failed, 0, 'no entry should fail');
        assert.strictEqual(succeeded, 8, 'all 8 entries should report success');

        const onDisk = await fs.readFile(filePath, 'utf-8');
        for (let i = 0; i <= 7; i++) {
            assert.ok(
                onDisk.includes(`block-${i}`),
                `reported success but block-${i} missing on disk. Got:\n${onDisk}`
            );
        }

        const order = [...onDisk.matchAll(/block-(\d)/g)].map(m => Number(m[1]));
        assert.deepStrictEqual(
            order, [0, 1, 2, 3, 4, 5, 6, 7],
            `same-path entries must land in submission order, got ${order}`
        );

        console.log('✓ same-path rewrite+appends are ordered and durable');
    });
}

/** All-append batch on a fresh path must not lose entries either. */
async function testSamePathAllAppends() {
    await withAllowedDir(async (dir) => {
        const filePath = path.join(dir, 'log.txt');
        await fs.writeFile(filePath, 'head\n', 'utf-8');

        const files = [];
        for (let i = 0; i < 10; i++) {
            files.push({ path: filePath, content: `entry-${i}\n`, mode: 'append' });
        }

        const result = await handleWriteMultipleFiles({ files });
        assert.strictEqual(result.structuredContent?.failed, 0, 'no entry should fail');

        const onDisk = await fs.readFile(filePath, 'utf-8');
        for (let i = 0; i < 10; i++) {
            assert.ok(onDisk.includes(`entry-${i}`), `entry-${i} missing on disk`);
        }
        assert.ok(onDisk.startsWith('head'), 'pre-existing content must be preserved');

        console.log('✓ same-path append batch keeps every entry');
    });
}

export default async function runTests() {
    await testSamePathRewriteThenAppends();
    await testSamePathAllAppends();
    return true;
}

if (process.argv[1]?.endsWith('test-write-multiple-same-path.js')) {
    runTests()
        .then(() => console.log('All write_multiple_files same-path tests passed'))
        .catch(err => { console.error('Test failed:', err); process.exit(1); });
}
