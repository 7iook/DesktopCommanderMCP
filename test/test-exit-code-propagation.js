/**
 * Regression test: real exit codes must survive the PowerShell wrapper.
 *
 * PowerShell collapses a child's exit status into its own success/failure
 * semantics, so `node -e "process.exit(7)"` surfaced as exit code 1. Every
 * non-zero code (127 command-not-found, 2 usage error, 130 SIGINT) arrived as
 * an indistinguishable 1, leaving the caller to guess why something failed.
 *
 * The wrapper now re-exports the child's status. The tricky part is that a
 * PowerShell-level failure (unknown command) never sets $LASTEXITCODE at all,
 * so a naive `exit $LASTEXITCODE` reports success for a failed command — this
 * test pins both directions.
 */

import assert from 'assert';
import { terminalManager } from '../dist/terminal-manager.js';

const isWindows = process.platform === 'win32';

// Invoke node the way a caller actually would. On Windows a *quoted* path with
// no `&` is parsed by PowerShell as a string literal rather than a command —
// the program never runs — so use the call operator, which is what any working
// PowerShell invocation of a quoted path looks like.
const NODE = isWindows ? `& "${process.execPath}"` : `"${process.execPath}"`;

async function runAndGetExitCode(command, timeoutMs = 20000) {
    const result = await terminalManager.executeCommand(command, timeoutMs);
    // Give the 'exit' handler a moment to file the completed session.
    for (let i = 0; i < 60; i++) {
        const completed = terminalManager.listCompletedSessions().find(s => s.pid === result.pid);
        if (completed) return completed.exitCode;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`process ${result.pid} never landed in completedSessions`);
}

async function testExplicitNonZeroCodeSurvives() {
    const code = await runAndGetExitCode(`${NODE} -e "process.exit(7)"`);
    assert.strictEqual(code, 7, `expected exit code 7, got ${code}`);
    console.log('✓ explicit exit code 7 survives the shell wrapper');
}

async function testDistinctCodesStayDistinct() {
    const c127 = await runAndGetExitCode(`${NODE} -e "process.exit(127)"`);
    const c2 = await runAndGetExitCode(`${NODE} -e "process.exit(2)"`);
    assert.strictEqual(c127, 127, `expected 127, got ${c127}`);
    assert.strictEqual(c2, 2, `expected 2, got ${c2}`);
    assert.notStrictEqual(c127, c2, 'distinct failures must stay distinguishable');
    console.log('✓ distinct non-zero codes stay distinct (127 vs 2)');
}

async function testSuccessIsStillZero() {
    const code = await runAndGetExitCode(`${NODE} -e "process.exit(0)"`);
    assert.strictEqual(code, 0, `expected 0, got ${code}`);
    console.log('✓ successful process still reports 0');
}

/** A shell builtin / cmdlet that never sets an exit code must not look failed. */
async function testPlainCommandReportsZero() {
    const command = isWindows ? 'Write-Output hello' : 'echo hello';
    const code = await runAndGetExitCode(command);
    assert.strictEqual(code, 0, `expected 0 for a plain successful command, got ${code}`);
    console.log('✓ plain successful shell command reports 0');
}

/**
 * The regression guard: an unknown command fails at the shell level without
 * ever setting $LASTEXITCODE. It must still report failure, not 0.
 */
async function testUnknownCommandStillFails() {
    const code = await runAndGetExitCode('nonexistentcommand_xyz123');
    assert.notStrictEqual(code, 0, 'unknown command must not report success');
    console.log(`✓ unknown command still reports failure (exit ${code})`);
}

export default async function runTests() {
    await testExplicitNonZeroCodeSurvives();
    await testDistinctCodesStayDistinct();
    await testSuccessIsStillZero();
    await testPlainCommandReportsZero();
    await testUnknownCommandStillFails();
    return true;
}

if (process.argv[1]?.endsWith('test-exit-code-propagation.js')) {
    runTests()
        .then(() => console.log('All exit-code propagation tests passed'))
        .catch(err => { console.error('Test failed:', err); process.exit(1); });
}
