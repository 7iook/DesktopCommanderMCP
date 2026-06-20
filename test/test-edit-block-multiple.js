// Test edit_block_multiple: batch surgical edits across files, per-file atomicity.
// Auto-discovered by run-all-tests.js.
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { editBlockMultiple } from '../dist/tools/edit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT = path.join(__dirname, 'test_output', 'ebm');

const c = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m' };
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`${c.green}  ✓ ${msg}${c.reset}`);
  else { console.log(`${c.red}  ✗ ${msg}${c.reset}`); failures++; }
}
function textOf(r) { return r?.content?.[0]?.text || ''; }
async function write(p, s) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s, 'utf-8'); }
async function read(p) { return fs.readFile(p, 'utf-8'); }

async function main() {
  console.log(`${c.blue}=== edit_block_multiple ===${c.reset}`);

  const fA = path.join(OUT, 'a.txt');
  const fB = path.join(OUT, 'b.txt');
  const fC = path.join(OUT, 'c.txt');

  try {
    // --- Test 1: multi-file multi-position, all succeed ---
    await write(fA, 'alpha\nbeta\ngamma\n');
    await write(fB, 'one\ntwo\nthree\n');
    let res = await editBlockMultiple([
      { file_path: fA, old_string: 'alpha', new_string: 'ALPHA' },
      { file_path: fA, old_string: 'gamma', new_string: 'GAMMA' },
      { file_path: fB, old_string: 'two', new_string: 'TWO' },
    ]);
    let t = textOf(res);
    assert(t.includes('2/2 files updated') && t.includes('3 edit(s) applied'), 'all edits applied across 2 files');
    assert((await read(fA)) === 'ALPHA\nbeta\nGAMMA\n', 'file A both edits landed');
    assert((await read(fB)) === 'one\nTWO\nthree\n', 'file B edit landed');
    assert(res.isError !== true, 'success run not flagged error');

    // --- Test 2: per-file atomicity — one bad edit reverts whole file ---
    await write(fC, 'keep1\nkeep2\nkeep3\n');
    res = await editBlockMultiple([
      { file_path: fC, old_string: 'keep1', new_string: 'CHANGED1' },
      { file_path: fC, old_string: 'NOT_PRESENT', new_string: 'x' },
    ]);
    t = textOf(res);
    assert((await read(fC)) === 'keep1\nkeep2\nkeep3\n', 'file C untouched (atomic) despite first edit matching');
    assert(t.includes('left unchanged') && t.includes('no exact match'), 'reports atomic skip + miss reason');

    // --- Test 3: cross-file independence (good file lands, bad file reverts) ---
    await write(fA, 'red\ngreen\n');
    await write(fB, 'sky\n');
    res = await editBlockMultiple([
      { file_path: fA, old_string: 'red', new_string: 'RED' },
      { file_path: fB, old_string: 'MISSING', new_string: 'x' },
    ]);
    assert((await read(fA)) === 'RED\ngreen\n', 'good file updated even when another file fails');
    assert((await read(fB)) === 'sky\n', 'bad file unchanged');
    assert(textOf(res).includes('1/2 files updated'), 'summary shows 1/2');

    // --- Test 4: expected_replacements mismatch fails that edit (atomic) ---
    await write(fA, 'dup\ndup\nkeep\n');
    res = await editBlockMultiple([
      { file_path: fA, old_string: 'dup', new_string: 'X' }, // 2 found, expected 1
    ]);
    assert((await read(fA)) === 'dup\ndup\nkeep\n', 'count-mismatch edit does not write');
    assert(textOf(res).includes('expected 1'), 'reports count mismatch');

    // --- Test 5: expected_replacements=N replaces all N ---
    await write(fA, 'dup\ndup\nkeep\n');
    res = await editBlockMultiple([
      { file_path: fA, old_string: 'dup', new_string: 'X', expected_replacements: 2 },
    ]);
    assert((await read(fA)) === 'X\nX\nkeep\n', 'expected_replacements=2 replaces both');

    // --- Test 6: CRLF preserved ---
    await write(fA, 'a\r\nb\r\nc\r\n');
    res = await editBlockMultiple([{ file_path: fA, old_string: 'b', new_string: 'B' }]);
    assert((await read(fA)) === 'a\r\nB\r\nc\r\n', 'CRLF line endings preserved');

    // --- Test 7: fuzzy hint on a near miss ---
    await write(fA, 'function doThing() {\n  return 1;\n}\n');
    res = await editBlockMultiple([
      { file_path: fA, old_string: 'function doThing(){', new_string: 'x' }, // missing space
    ]);
    assert(textOf(res).includes('closest') && /\d+%/.test(textOf(res)), 'miss includes fuzzy closest-match hint');
  } catch (err) {
    console.log(`${c.red}Unexpected: ${err.stack || err}${c.reset}`);
    failures++;
  } finally {
    await fs.rm(OUT, { recursive: true, force: true });
  }

  if (failures > 0) { console.log(`${c.red}\n${failures} failed${c.reset}`); process.exit(1); }
  console.log(`${c.green}\nAll edit_block_multiple tests passed${c.reset}`);
  process.exit(0);
}

main();
