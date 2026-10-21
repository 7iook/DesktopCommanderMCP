import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProcessState } from '../dist/utils/process-detection.js';

// Regression for the tool-anomaly feedback (2026-07-09): ordinary Rust
// toolchain output was mislabeled "waiting for input" because REPL prompt
// detection used lastLine.includes('... ' | '> ') with no partial-line gate.
// A real REPL parks the cursor on the prompt WITHOUT a trailing newline;
// one-shot command output that merely contains these chars ends in a newline
// or has them mid-line. Fix: endsWith + cursorOnPartialLine gate.

test('cargo test "... ok" progress lines are NOT waiting for input', () => {
  const out = 'running 3 tests\ntest fitness_ignores_comments_and_prose ... ok\n';
  const st = analyzeProcessState(out, 1234);
  assert.equal(st.isWaitingForInput, false);
});

test('cargo test line ending in "... " but newline-terminated is NOT input', () => {
  // The "... " appears then the line is completed and a newline follows.
  const out = 'test some::really_long_case_name ... ok\ntest done\n';
  const st = analyzeProcessState(out, 1234);
  assert.equal(st.isWaitingForInput, false);
});

test('clippy/rustc diagnostics containing ">" are NOT waiting for input', () => {
  const out = [
    'warning: this comparison...',
    '  --> src/lib.rs:42:5',
    '   |',
    '42 |     assert_eq!(x, true);',
    '   |     ^^^^^^^^^^^^^^^^^^^ help: replace it with: `assert!(x)`',
    '',
  ].join('\n');
  const st = analyzeProcessState(out, 1234);
  assert.equal(st.isWaitingForInput, false);
});

test('trailing "> " mid-stream (newline-terminated) is NOT waiting for input', () => {
  const out = 'help: consider using `foo > bar`\n';
  const st = analyzeProcessState(out, 1234);
  assert.equal(st.isWaitingForInput, false);
});

// Guard the other direction: genuine REPL prompts on a partial line MUST
// still be detected, otherwise the fix would break interactive REPLs.

test('python ">>> " prompt on a partial line IS waiting for input', () => {
  const out = 'Python 3.11.0\n>>> ';
  const st = analyzeProcessState(out, 1234);
  assert.equal(st.isWaitingForInput, true);
  assert.equal(st.detectedPrompt, '>>> ');
});

test('node "> " prompt on a partial line IS waiting for input', () => {
  const out = 'Welcome to Node.js\n> ';
  const st = analyzeProcessState(out, 1234);
  assert.equal(st.isWaitingForInput, true);
});

test('python continuation "... " on a partial line IS waiting for input', () => {
  const out = '>>> def f():\n... ';
  const st = analyzeProcessState(out, 1234);
  assert.equal(st.isWaitingForInput, true);
});
