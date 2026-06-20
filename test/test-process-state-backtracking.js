// Regression: analyzeProcessState must not catastrophically backtrack on a
// long partial last line (no trailing newline). Such input previously pegged
// one core at ~100% inside APP_PROMPT_PATTERNS, freezing the event loop and
// wedging the whole MCP server until restart.
import { analyzeProcessState } from '../dist/utils/process-detection.js';

const c = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', blue: '\x1b[34m' };
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`${c.green}  \u2713 ${msg}${c.reset}`);
  else { console.log(`${c.red}  \u2717 ${msg}${c.reset}`); failures++; }
}

function timed(fn) { const t = Date.now(); fn(); return Date.now() - t; }

console.log(`${c.blue}=== analyzeProcessState backtracking guard ===${c.reset}`);

// Adversarial: long line of word-ish chars + spaces/dashes/dots, NO trailing
// newline, NO terminating ':' — worst case for the greedy colon-end pattern.
const evil = 'a -.'.repeat(60000); // ~240KB single partial line
let ms1 = timed(() => analyzeProcessState(evil));
assert(ms1 < 1000, `240KB partial line returns fast (${ms1}ms, was effectively infinite)`);

// Another shape: many word chars then space, no newline, no colon.
const evil2 = 'enter input select choose '.repeat(8000); // ~200KB, starts with prompt words
let ms2 = timed(() => analyzeProcessState(evil2));
assert(ms2 < 1000, `200KB prompt-wordy partial line returns fast (${ms2}ms)`);

// Correctness preserved: a real short prompt on a partial line still detected.
const okPrompt = 'Please enter your name: ';
const st = analyzeProcessState(okPrompt);
assert(st.isWaitingForInput === true, 'short real prompt still detected as waiting-for-input');

// Normal completed output unaffected.
const done = 'build finished\nExit code: 0\n';
assert(analyzeProcessState(done).isFinished === true, 'completion indicator still detected');

if (failures > 0) { console.log(`${c.red}\n${failures} failed${c.reset}`); process.exit(1); }
console.log(`${c.green}\nAll backtracking-guard tests passed${c.reset}`);
process.exit(0);
