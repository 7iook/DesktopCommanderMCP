// Test list_multiple_directories: batch directory listing, per-dir errors isolated.
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { handleListMultipleDirectories } from '../dist/handlers/filesystem-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT = path.join(__dirname, 'test_output', 'lmd');

const col = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', blue: '\x1b[34m' };
let failures = 0;
function assert(c, m) { if (c) console.log(`${col.green}  ✓ ${m}${col.reset}`); else { console.log(`${col.red}  ✗ ${m}${col.reset}`); failures++; } }
function textOf(r) { return r?.content?.[0]?.text || ''; }

async function main() {
  console.log(`${col.blue}=== list_multiple_directories ===${col.reset}`);
  const dA = path.join(OUT, 'dirA');
  const dB = path.join(OUT, 'dirB');
  const missing = path.join(OUT, 'nope-does-not-exist');
  try {
    await fs.mkdir(dA, { recursive: true });
    await fs.mkdir(path.join(dB, 'sub'), { recursive: true });
    await fs.writeFile(path.join(dA, 'fileA1.txt'), 'x', 'utf-8');
    await fs.writeFile(path.join(dB, 'fileB1.txt'), 'y', 'utf-8');
    await fs.writeFile(path.join(dB, 'sub', 'deep.txt'), 'z', 'utf-8');

    // Test 1: two valid dirs in one call, each with its own header + entries.
    let res = await handleListMultipleDirectories({ paths: [dA, dB] });
    let t = textOf(res);
    assert(t.includes('Listed 2/2 directories'), 'both directories listed');
    assert(t.includes(dA) && t.includes(dB), 'both dir headers present');
    assert(t.includes('fileA1.txt') && t.includes('fileB1.txt'), 'entries from both dirs present');
    assert(res.isError !== true, 'success not flagged error');

    // Test 2: one missing dir isolated, others still succeed.
    res = await handleListMultipleDirectories({ paths: [dA, missing] });
    t = textOf(res);
    assert(t.includes('Listed 1/2 directories') && t.includes('1 failed'), 'missing dir isolated, summary 1/2');
    assert(t.includes('fileA1.txt'), 'valid dir still listed alongside failure');
    assert(t.includes('ERROR'), 'failed dir marked ERROR');

    // Test 3: depth passthrough (depth=1 should not include nested deep.txt).
    res = await handleListMultipleDirectories({ paths: [dB], depth: 1 });
    t = textOf(res);
    assert(!t.includes('deep.txt'), 'depth=1 excludes nested file');

    // Test 4: single-element paths works.
    res = await handleListMultipleDirectories({ paths: [dA] });
    assert(textOf(res).includes('Listed 1/1 directories'), 'single dir works');
  } catch (err) {
    console.log(`${col.red}Unexpected: ${err.stack || err}${col.reset}`); failures++;
  } finally {
    await fs.rm(OUT, { recursive: true, force: true });
  }
  if (failures > 0) { console.log(`${col.red}\n${failures} failed${col.reset}`); process.exit(1); }
  console.log(`${col.green}\nAll list_multiple_directories tests passed${col.reset}`);
  process.exit(0);
}
main();
