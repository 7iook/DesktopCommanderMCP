/**
 * Regression test: write_file overwrite rejections must hand the caller ONE
 * argument set that succeeds on the very next call.
 *
 * Two guards used to stack on write_file without knowing about each other:
 * the "no mode on a non-empty file" guard (#546) only suggested mode:'rewrite',
 * and the overwrite-protection guard only suggested allowOverwrite:true. An AI
 * following either hint hit the other guard, so replacing a file took ~3 calls.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import assert from 'assert';

const { handleWriteFile } = await import('../dist/handlers/filesystem-handlers.js');
const { configManager } = await import('../dist/config-manager.js');

const REPLACE_ARGS = "mode:'rewrite', allowOverwrite:true";

async function withExistingFile(fn) {
    const original = await configManager.getConfig();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-wfo-'));
    const filePath = path.join(dir, 'handoff.md');
    await fs.writeFile(filePath, 'old content\n', 'utf-8');
    try {
        await configManager.setValue('allowedDirectories', [dir, os.tmpdir()]);
        await configManager.setValue('writeFileOverwriteProtection', true);
        return await fn(filePath);
    } finally {
        await configManager.setValue('allowedDirectories', original.allowedDirectories ?? []);
        await configManager.setValue('writeFileOverwriteProtection', original.writeFileOverwriteProtection ?? true);
        await fs.rm(dir, { recursive: true, force: true });
    }
}

const textOf = (r) => r.content?.map(c => c.text).join('\n') ?? '';

/** allowOverwrite:true already states the intent to replace; mode is redundant. */
async function testAllowOverwriteWithoutModeReplaces() {
    await withExistingFile(async (filePath) => {
        const r = await handleWriteFile({ path: filePath, content: 'new content\n', allowOverwrite: true });
        assert.ok(!r.isError, `should succeed in one call, got: ${textOf(r)}`);
        assert.strictEqual(await fs.readFile(filePath, 'utf-8'), 'new content\n');
        console.log('✓ allowOverwrite:true without mode replaces in one call');
    });
}

/** No mode, no allowOverwrite: rejected, and the suggested replace args work verbatim. */
async function testNoModeRejectionGivesWorkingArgs() {
    await withExistingFile(async (filePath) => {
        const r = await handleWriteFile({ path: filePath, content: 'new content\n' });
        assert.ok(r.isError, 'omitted mode on a non-empty file must still be rejected');
        assert.ok(textOf(r).includes(REPLACE_ARGS), `rejection must name ${REPLACE_ARGS}, got:\n${textOf(r)}`);
        assert.ok(textOf(r).includes("mode:'append'"), 'rejection must name the append alternative');
        assert.strictEqual(await fs.readFile(filePath, 'utf-8'), 'old content\n', 'rejected write must not touch the file');

        const retry = await handleWriteFile({ path: filePath, content: 'new content\n', mode: 'rewrite', allowOverwrite: true });
        assert.ok(!retry.isError, `suggested args must succeed, got: ${textOf(retry)}`);
        console.log('✓ no-mode rejection names args that succeed on the next call');
    });
}

/** mode:'rewrite' without allowOverwrite: rejected with the same complete arg set. */
async function testRewriteRejectionGivesWorkingArgs() {
    await withExistingFile(async (filePath) => {
        const r = await handleWriteFile({ path: filePath, content: 'new content\n', mode: 'rewrite' });
        assert.ok(r.isError, 'rewrite without allowOverwrite must be rejected while protection is on');
        assert.ok(textOf(r).includes(REPLACE_ARGS), `rejection must name ${REPLACE_ARGS}, got:\n${textOf(r)}`);
        assert.strictEqual(await fs.readFile(filePath, 'utf-8'), 'old content\n');
        console.log('✓ rewrite rejection names args that succeed on the next call');
    });
}

export default async function runTests() {
    await testAllowOverwriteWithoutModeReplaces();
    await testNoModeRejectionGivesWorkingArgs();
    await testRewriteRejectionGivesWorkingArgs();
    return true;
}

if (process.argv[1]?.endsWith('test-write-file-overwrite-guidance.js')) {
    runTests()
        .then(() => console.log('All write_file overwrite-guidance tests passed'))
        .catch(err => { console.error('Test failed:', err); process.exit(1); });
}
