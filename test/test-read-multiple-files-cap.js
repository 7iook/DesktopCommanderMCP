// Test read_multiple_files batch char cap: total text bounded, nothing silently dropped.
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { handleReadMultipleFiles } from '../dist/handlers/filesystem-handlers.js';
import { configManager } from '../dist/config-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT = path.join(__dirname, 'test_output', 'rmf-cap');

const col = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', blue: '\x1b[34m' };
let failures = 0;
function assert(c, m) { if (c) console.log(`${col.green}  ✓ ${m}${col.reset}`); else { console.log(`${col.red}  ✗ ${m}${col.reset}`); failures++; } }
function allText(r) { return (r?.content || []).filter(c => c.type === 'text').map(c => c.text).join(''); }

async function main() {
  console.log(`${col.blue}=== read_multiple_files char cap ===${col.reset}`);
  const CAP = 20000;
  const originalCap = await configManager.getValue('responseMaxChars');
  try {
    await fs.mkdir(OUT, { recursive: true });
    await configManager.setValue('responseMaxChars', CAP);

    // Three files whose combined size is ~3x the cap.
    const big = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(OUT, `big${i}.txt`);
      // Multi-line so the truncation path isn't the minified branch.
      await fs.writeFile(p, (`line ${i} ` + 'x'.repeat(60) + '\n').repeat(300), 'utf-8');
      big.push(p);
    }
    const small = path.join(OUT, 'small.txt');
    await fs.writeFile(small, 'tiny content\n', 'utf-8');

    // Test 1: under cap → byte-identical pass-through (no regression).
    let res = await handleReadMultipleFiles({ paths: [small] });
    let t = allText(res);
    assert(t.includes('tiny content'), 'small file content returned in full');
    assert(!t.includes('Batch capped'), 'no cap note when batch fits');

    // Test 2: oversized batch → total text bounded by the cap (+ the note).
    res = await handleReadMultipleFiles({ paths: big });
    t = allText(res);
    const rawTotal = (await Promise.all(big.map(p => fs.readFile(p, 'utf-8')))).reduce((n, s) => n + s.length, 0);
    assert(rawTotal > CAP * 2, `fixture is genuinely oversized (${rawTotal} chars vs cap ${CAP})`);
    assert(t.length < CAP * 1.2, `combined text bounded: ${t.length} chars vs cap ${CAP}`);

    // Test 3: the AI is told the batch is incomplete — the whole point.
    assert(t.includes('Batch capped'), 'cap note present when batch exceeds budget');
    assert(/Truncated|NOT included/.test(t), 'note distinguishes truncated / omitted');
    assert(t.includes('read_file'), 'note points at read_file to fetch the rest');

    // Test 4: every requested path still appears in the summary index, so a
    // capped batch can never look like "those files do not exist".
    for (const p of big) assert(t.includes(p), `path still listed in summary: ${path.basename(p)}`);

    // Test 5: first file keeps real content (budget spent in call order, not
    // starved into a batch of stubs).
    assert(t.includes('line 0 '), 'first file body present');

    // Test 6: raising the cap restores full content (escape hatch works).
    await configManager.setValue('responseMaxChars', rawTotal + 10000);
    res = await handleReadMultipleFiles({ paths: big });
    t = allText(res);
    assert(!t.includes('Batch capped'), 'no cap note once cap is raised above batch size');
    assert(t.includes('line 2 '), 'last file body present when cap is raised');
  } catch (err) {
    console.log(`${col.red}Unexpected: ${err.stack || err}${col.reset}`); failures++;
  } finally {
    if (originalCap === undefined) await configManager.setValue('responseMaxChars', 50000);
    else await configManager.setValue('responseMaxChars', originalCap);
    await fs.rm(OUT, { recursive: true, force: true });
  }
  if (failures > 0) { console.log(`${col.red}\n${failures} failed${col.reset}`); process.exit(1); }
  console.log(`${col.green}\nAll read_multiple_files cap tests passed${col.reset}`);
  process.exit(0);
}
main();
