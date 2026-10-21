/**
 * Regression test: a PowerShell CLIXML envelope that filters down to nothing
 * must not count as the stream's latest output.
 *
 * recordOutput() stamps each stream with the event-loop turn that delivered
 * it, and the process state is judged from the streams of the latest turn.
 * A progress-only envelope on stderr filters to '' — if that still stamped
 * stderr, an old ">>> " left in stderr's tail became "the latest output" and
 * a running command was reported as waiting for input (Blocked: true).
 */
import assert from 'assert';
import { terminalManager } from '../dist/terminal-manager.js';
import { analyzeProcessState } from '../dist/utils/process-detection.js';

const OBJS = '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress"><T>Completed</T></Obj></Objs>';
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function fakeSession() {
    return {
        outputLines: [], bufferedChars: 0, stripCliXml: true, cliXmlCarry: '',
        streams: { stdout: { text: '', chars: 0, turn: 0 }, stderr: { text: '', chars: 0, turn: 0 } },
    };
}

function record(session, stream, raw) {
    terminalManager['recordOutput'](session, stream, terminalManager['filterCliXmlStream'](session, raw));
}

function state(session) {
    return analyzeProcessState(terminalManager.constructor['lastWrittenOutput'](session.streams), 1);
}

async function testFilteredNoiseDoesNotReviveOldPrompt() {
    const s = fakeSession();
    record(s, 'stderr', '>>> ');
    await nextTurn();
    record(s, 'stdout', 'work continues\n');
    await nextTurn();
    assert.strictEqual(state(s).isWaitingForInput, false, 'output after the prompt means it is running');

    record(s, 'stderr', `#< CLIXML\r\n${OBJS}`);
    await nextTurn();
    assert.strictEqual(state(s).isWaitingForInput, false,
        `a progress-only envelope must not revive the old prompt, got ${JSON.stringify(state(s))}`);
    assert.strictEqual(s.streams.stderr.chars, 4, 'filtered-away noise adds no characters');
    console.log('✓ filtered CLIXML noise leaves the process running, not waiting');
}

export default async function runTests() {
    await testFilteredNoiseDoesNotReviveOldPrompt();
    return true;
}

if (process.argv[1]?.endsWith('test-clixml-prompt-state.js')) {
    runTests()
        .then(() => console.log('All CLIXML prompt-state tests passed'))
        .catch(err => { console.error('Test failed:', err); process.exit(1); });
}
