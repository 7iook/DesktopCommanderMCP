// Test listDirectory global bounds (entry cap + time budget) — prevents the
// unbounded-walk hang that timed out the MCP request (-32001) on huge trees.
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { listDirectory } from '../dist/tools/filesystem.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT = path.join(__dirname, 'test_output', 'listdir-bound');

const col = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', blue: '\x1b[34m' };
let failures = 0;
function assert(c, m) { if (c) console.log(`${col.green}  ✓ ${m}${col.reset}`); else { console.log(`${col.red}  ✗ ${m}${col.reset}`); failures++; } }

async function main() {
  console.log(`${col.blue}=== listDirectory bounds ===${col.reset}`);
  try {
    await fs.mkdir(OUT, { recursive: true });
    // Create 200 files to exercise the cap with a small maxEntries.
    await Promise.all(Array.from({ length: 200 }, (_, i) =>
      fs.writeFile(path.join(OUT, `f${String(i).padStart(3, '0')}.txt`), 'x', 'utf-8')));

    // Test 1: entry cap stops the walk and appends a TRUNCATED marker.
    const capped = await listDirectory(OUT, 1, { maxEntries: 50 });
    const truncated = capped.filter(l => l.startsWith('[TRUNCATED]'));
    assert(truncated.length === 1, 'exactly one [TRUNCATED] marker on cap');
    assert(capped.length <= 51, `entry cap bounded result (got ${capped.length}, <=51)`);

    // Test 2: normal small dir under the cap returns everything, no marker.
    const full = await listDirectory(OUT, 1, { maxEntries: 100000 });
    assert(!full.some(l => l.startsWith('[TRUNCATED]')), 'no marker when under cap');
    assert(full.length === 200, `all 200 entries returned (got ${full.length})`);

    // Test 3: time budget of 0ms stops almost immediately with a marker.
    const timed = await listDirectory(OUT, 1, { timeBudgetMs: 0 });
    assert(timed.some(l => l.startsWith('[TRUNCATED]')) && /time budget/.test(timed.join('\n')),
      'zero time budget triggers time-based truncation');

    // Test 4: default call (no opts) still works on a small dir.
    const def = await listDirectory(OUT);
    assert(def.length === 200 && !def.some(l => l.startsWith('[TRUNCATED]')), 'default opts unchanged for small dir');
  } catch (err) {
    console.log(`${col.red}Unexpected: ${err.stack || err}${col.reset}`); failures++;
  } finally {
    await fs.rm(OUT, { recursive: true, force: true });
  }
  if (failures > 0) { console.log(`${col.red}\n${failures} failed${col.reset}`); process.exit(1); }
  console.log(`${col.green}\nAll listDirectory bound tests passed${col.reset}`);
  process.exit(0);
}
main();
