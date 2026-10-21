/**
 * Regression test: the history size cap must not hide anomalies.
 *
 * ToolHistory replaces an output over its byte cap with a short omission
 * marker. The anomaly rules read the output text, so a large batch write in
 * which 20 of 21 entries hit overwrite protection (isError:false, one entry
 * succeeded) stopped being reported by get_recent_anomalies at all.
 */
import assert from 'assert';
import { toolHistory } from '../dist/utils/toolHistory.js';
import { detectAnomalies } from '../dist/utils/anomaly-detector.js';

async function testCappedRecordKeepsItsAnomaly() {
    const marker = `cap-probe-${process.pid}-${Date.now()}`;
    const lines = ['Wrote 1 of 21 files (1 succeeded, 20 failed)'];
    for (let i = 0; i < 20; i++) {
        lines.push(`✗ ${marker}/file-${i}.md — File already exists (7450 bytes); rewrite would overwrite it. ` +
            `Retry with mode:'rewrite', allowOverwrite:true to replace it, mode:'append' to add to the end, or use edit_block.` +
            ' '.repeat(200));
    }
    toolHistory.addCall('write_multiple_files', { files: [{ path: `${marker}/file-0.md` }] }, {
        content: [{ type: 'text', text: lines.join('\n') }],
    }, 4);

    const record = toolHistory.getRecentCalls({ toolName: 'write_multiple_files', maxResults: 50 })
        .find(r => r.arguments?.files?.[0]?.path === `${marker}/file-0.md`);
    assert.ok(record, 'the probe record is in history');
    assert.match(record.output.content[0].text, /output omitted from history/, 'the stored output is still capped');
    assert.ok(JSON.stringify(record).length < 4096, `the capped record stays small, got ${JSON.stringify(record).length} chars`);

    const ids = detectAnomalies(record).map(h => h.ruleId);
    assert.ok(ids.includes('write_file_overwrite_blocked'),
        `the capped record must still report write_file_overwrite_blocked, got ${JSON.stringify(ids)}`);
    console.log('✓ a capped history record still reports the anomaly its full output showed');
}

export default async function runTests() {
    await testCappedRecordKeepsItsAnomaly();
    return true;
}

if (process.argv[1]?.endsWith('test-anomaly-history-cap.js')) {
    runTests()
        .then(() => { console.log('All anomaly history-cap tests passed'); process.exit(0); })
        .catch(err => { console.error('Test failed:', err); process.exit(1); });
}
