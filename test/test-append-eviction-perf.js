// Regression: appendToLineBuffer eviction must be O(n), not O(n^2).
// A process emitting lots of short lines fills the per-session buffer toward
// the 50MB cap; every subsequent chunk then evicts oldest lines. The old code
// used Array.shift() per evicted line (O(n) each) => O(n*k) per chunk, which
// pegged the main thread for seconds on verbose output and froze the whole MCP
// server (the stall watchdog pinpointed appendToLineBuffer). Bulk splice fixes it.
import { terminalManager } from '../dist/terminal-manager.js';

const c = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', blue: '\x1b[34m' };
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`${c.green}  \u2713 ${msg}${c.reset}`);
  else { console.log(`${c.red}  \u2717 ${msg}${c.reset}`); failures++; }
}

console.log(`${c.blue}=== appendToLineBuffer eviction perf (O(n) not O(n^2)) ===${c.reset}`);

// Fake session matching the fields appendToLineBuffer touches.
const session = { outputLines: [], bufferedChars: 0, evictedChars: 0, evictedLines: 0, lastReadIndex: 0 };
const append = terminalManager['appendToLineBuffer'].bind(terminalManager);

// Build a ~34KB chunk of short lines (≈ the real trigger size), then push ~70MB
// of it. Old O(n^2) code would take minutes / hang here; bulk splice ~seconds.
const line = 'x'.repeat(48) + '\n';          // ~49 chars/line
const chunk = line.repeat(700);              // ~34KB per chunk
const CAP = 50 * 1024 * 1024;
const totalTarget = 70 * 1024 * 1024;        // exceed cap by 20MB -> heavy eviction
const chunks = Math.ceil(totalTarget / chunk.length);

const t0 = Date.now();
for (let i = 0; i < chunks; i++) append(session, chunk);
const ms = Date.now() - t0;

assert(ms < 8000, `pushed ~70MB in ${chunks} chunks in ${ms}ms (<8000ms; O(n^2) would hang)`);
assert(session.bufferedChars <= CAP, `buffer stayed within cap (${session.bufferedChars} <= ${CAP})`);
assert(session.outputLines.length > 0, 'buffer not empty');
assert(session.evictedLines > 0, `eviction happened (evictedLines=${session.evictedLines})`);
// content integrity: every retained line is the expected short line (or a fragment)
assert(session.outputLines.every(l => l.length <= 1024 * 1024), 'no line exceeds MAX_LINE_CHARS');

if (failures > 0) { console.log(`${c.red}\n${failures} failed${c.reset}`); process.exit(1); }
console.log(`${c.green}\nAll append eviction perf tests passed${c.reset}`);
process.exit(0);
