// Test get_recent_tool_calls output bounding: history replays call metadata, not payloads.
//
// Isolation note: tool history is a GLOBAL persisted log — the live MCP server's
// own calls are in there too. Asserting substrings against the whole blob passes
// for the wrong reason (an edit_block that echoed this file's source once made
// the "output omitted" assertion green before the fix existed). So every
// assertion here is scoped to a unique synthetic tool name via the toolName
// filter, and reads the parsed records rather than the raw text.
import { handleGetRecentToolCalls } from '../dist/handlers/history-handlers.js';
import { toolHistory } from '../dist/utils/toolHistory.js';
import { configManager } from '../dist/config-manager.js';

const col = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', blue: '\x1b[34m' };
let failures = 0;
function assert(c, m) { if (c) console.log(`${col.green}  ✓ ${m}${col.reset}`); else { console.log(`${col.red}  ✗ ${m}${col.reset}`); failures++; } }
function textOf(r) { return (r?.content || []).filter(c => c.type === 'text').map(c => c.text).join(''); }
function recordsOf(text) {
  const start = text.indexOf('[');
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

const HEAVY = '__cap_probe_heavy';
const LIGHT = '__cap_probe_light';
const ERRING = '__cap_probe_error';

async function main() {
  console.log(`${col.blue}=== get_recent_tool_calls output bounding ===${col.reset}`);
  const originalCap = await configManager.getValue('responseMaxChars');
  try {
    await configManager.setValue('responseMaxChars', 50000);

    // Test 1: a small call is replayed intact (no regression for the normal case).
    toolHistory.addCall(LIGHT, { path: 'a.txt' }, {
      content: [{ type: 'text', text: 'size: 12' }]
    }, 3);
    let t = textOf(await handleGetRecentToolCalls({ maxResults: 5, toolName: LIGHT }));
    let recs = recordsOf(t);
    assert(recs !== null && recs.length >= 1, 'light record returned and parseable');
    assert(t.includes('size: 12'), 'small output kept intact');
    assert(!t.includes('output omitted'), 'small output NOT flagged as omitted');

    // Test 2: 30 heavy calls — the shape that measured 1.39M chars before.
    for (let i = 0; i < 30; i++) {
      toolHistory.addCall(HEAVY, { paths: [`f${i}.ts`] }, {
        content: [{ type: 'text', text: 'x'.repeat(45000) }]
      }, 12);
    }
    t = textOf(await handleGetRecentToolCalls({ maxResults: 50, toolName: HEAVY }));
    assert(t.length < 60000, `response bounded: ${t.length} chars (1444432 uncapped)`);

    // Test 3+4: scoped to OUR records only, so ambient history can't fake it.
    recs = recordsOf(t);
    assert(recs !== null, 'capped response is still valid JSON');
    const mine = (recs || []).filter(r => r.toolName === HEAVY);
    assert(mine.length > 0, 'heavy records present');
    assert(mine.every(r => typeof r.output?._note === 'string' && r.output._note.includes('output omitted')),
      'every heavy record states its output was omitted');
    assert(mine.every(r => r.output?._note?.includes('re-run the tool')),
      'each note tells the AI how to get the real content');
    assert(mine.every(r => !JSON.stringify(r.output).includes('x'.repeat(1000))),
      'no heavy payload replayed in any record');
    assert(mine.some(r => Array.isArray(r.arguments?.paths)),
      'arguments still present (what was called)');

    // Test 5: error/success distinguishable — the main thing history is used for.
    toolHistory.addCall(ERRING, { command: 'boom' }, {
      content: [{ type: 'text', text: 'e'.repeat(40000) }], isError: true
    }, 5);
    recs = recordsOf(textOf(await handleGetRecentToolCalls({ maxResults: 5, toolName: ERRING })));
    const errRec = (recs || []).find(r => r.toolName === ERRING);
    assert(errRec?.output?.isError === true, 'isError preserved through the preview');
    assert(typeof errRec?.output?.firstTextPreview === 'string' && errRec.output.firstTextPreview.length <= 800,
      'error text preview kept but bounded');
  } catch (err) {
    console.log(`${col.red}Unexpected: ${err.stack || err}${col.reset}`); failures++;
  } finally {
    if (originalCap === undefined) await configManager.setValue('responseMaxChars', 50000);
    else await configManager.setValue('responseMaxChars', originalCap);
  }
  if (failures > 0) { console.log(`${col.red}\n${failures} failed${col.reset}`); process.exit(1); }
  console.log(`${col.green}\nAll get_recent_tool_calls bounding tests passed${col.reset}`);
  process.exit(0);
}
main();
