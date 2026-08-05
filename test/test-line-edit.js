/**
 * edit_lines — line-structural editing.
 *
 * The cases here mirror the failures that made a real 6-round spec review expensive:
 * shell escaping ate backticks three times, list renumbering after a mid-block insert had
 * to be done with throwaway scripts, and a work-package line ended up in the wrong place.
 * Every one of those is a line-structure operation with no tool behind it until now.
 */
import path from 'path';
import fs from 'fs/promises';
import assert from 'assert';
import { fileURLToPath } from 'url';
import { applyLineEdit, hashLineRange } from '../dist/utils/files/lineEdit.js';
import { handleEditLines } from '../dist/tools/edit.js';
import { configManager } from '../dist/config-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '_tmp-line-edit');

let passed = 0;
// Test names stay ASCII-only. The fixtures below deliberately contain CJK and emoji,
// and echoing those to stdout makes the result depend on the console's code page — under
// the suite runner (piped stdout, GBK console) that turned a passing assertion into a
// write error. What the bytes survive is asserted against the FILE, never printed.
const ok = (cond, name) => {
  assert.ok(cond, name);
  console.log(`  ✓ ${name}`);
  passed++;
};

const write = (p, s) => fs.writeFile(p, s, 'utf8');
const read = (p) => fs.readFile(p, 'utf8');
const textOf = (res) => res.content.map(c => c.text).join('\n');

const LIST = [
  '# Doc',                    // 1
  '',                         // 2
  '## Items',                 // 3
  '',                         // 4
  '1. first',                 // 5
  '2. second',                // 6
  '3. third',                 // 7
  '4. fourth',                // 8
  '',                         // 9
  '## Other',                 // 10
  '',                         // 11
  'tail',                     // 12
  '',                         // 13
].join('\n');

async function run() {
  await fs.mkdir(DIR, { recursive: true });

  // The suite shares one config file across modules and several earlier tests narrow
  // allowedDirectories to their own fixture dir. Without claiming our own directory here,
  // validatePath rejects this file and every tool-level case below fails for a reason that
  // has nothing to do with line editing. The previous value is restored in the finally.
  const priorAllowed = (await configManager.getConfig()).allowedDirectories;
  await configManager.setValue('allowedDirectories', [DIR]);
  try {
    await runCases(path.join(DIR, 'doc.md'));
  } finally {
    // Restore on every path, including a thrown assertion: leaving the suite's shared
    // config pointed at our fixture dir would break whatever module runs next.
    await configManager.setValue('allowedDirectories', priorAllowed);
  }
}

async function runCases(f) {

  // ---- pure-function level: the semantics, without I/O ----

  // renumber after a mid-list insert — the "2.10 appears twice" collision, generalized
  const inserted = LIST.replace('3. third', '3. INSERTED\n3. third');
  let r = applyLineEdit(inserted, { op: 'renumber', startLine: 5, endLine: 9 }, '\n');
  ok(r.ok, 'renumber accepts a range containing a duplicate number');
  ok(/1\. first[\s\S]*2\. second[\s\S]*3\. INSERTED[\s\S]*4\. third[\s\S]*5\. fourth/.test(r.content),
     'renumber resequences 1..5 and eliminates the collision');

  r = applyLineEdit(LIST, { op: 'renumber', startLine: 5, endLine: 8, startAt: 10 }, '\n');
  ok(/10\. first[\s\S]*13\. fourth/.test(r.content), 'renumber honours startAt');

  r = applyLineEdit(LIST, { op: 'renumber', startLine: 10, endLine: 12 }, '\n');
  ok(!r.ok && /no numbered items/.test(r.error), 'renumber over a range with no items fails loudly');

  r = applyLineEdit(LIST, { op: 'renumber', startLine: 5, endLine: 8, expectedLines: 3 }, '\n');
  ok(!r.ok && /found 4 numbered/.test(r.error), 'renumber respects an expectedLines contract');

  // indentation and delimiter must survive — a nested list keeps its shape
  const NESTED = ['1. a', '   1) x', '   2) y', '2. b'].join('\n');
  r = applyLineEdit(NESTED, { op: 'renumber', startLine: 2, endLine: 3 }, '\n');
  ok(r.content === ['1. a', '   1) x', '   2) y', '2. b'].join('\n'),
     'renumber preserves indentation and the ")" delimiter');

  // move — the "W-F line ended up after the addendum" failure
  r = applyLineEdit(LIST, { op: 'move', startLine: 5, endLine: 5, afterLine: 8 }, '\n');
  ok(r.ok && /2\. second[\s\S]*3\. third[\s\S]*4\. fourth[\s\S]*1\. first/.test(r.content),
     'move relocates a line after a later line');

  r = applyLineEdit(LIST, { op: 'move', startLine: 10, endLine: 12, afterLine: 0 }, '\n');
  ok(r.content.startsWith('## Other'), 'afterLine 0 moves a block to the top of the file');

  r = applyLineEdit(LIST, { op: 'move', startLine: 5, endLine: 8, afterLine: 6 }, '\n');
  ok(!r.ok && /inside the moved range/.test(r.error),
     'a destination inside the moved range is refused, not guessed');

  // replace_pattern — bounded, and the count is a contract
  r = applyLineEdit(LIST, {
    op: 'replace_pattern', startLine: 5, endLine: 8,
    pattern: '^(\\d+)\\. ', replacement: '$1) ', expectedLines: 4,
  }, '\n');
  ok(r.ok && /1\) first/.test(r.content) && /4\) fourth/.test(r.content),
     'replace_pattern applies with $1 group references');

  r = applyLineEdit(LIST, {
    op: 'replace_pattern', startLine: 5, endLine: 8,
    pattern: '^(\\d+)\\. ', replacement: '$1) ', expectedLines: 2,
  }, '\n');
  ok(!r.ok && /changed 4 line\(s\) but expectedLines=2/.test(r.error),
     'a count mismatch aborts instead of applying');

  r = applyLineEdit(LIST, {
    op: 'replace_pattern', startLine: 5, endLine: 8,
    pattern: 'NOTHING', replacement: 'x', expectedLines: 1,
  }, '\n');
  ok(!r.ok && /matched nothing/.test(r.error), 'a pattern matching nothing says so');

  r = applyLineEdit(LIST, {
    op: 'replace_pattern', startLine: 5, endLine: 8,
    pattern: 'a', replacement: 'b', expectedLines: 1, flags: 'm',
  }, '\n');
  ok(!r.ok && /flag "m" is not allowed/.test(r.error), 'the m flag is rejected');

  r = applyLineEdit(LIST, {
    op: 'replace_pattern', startLine: 5, endLine: 8,
    pattern: '([', replacement: 'x', expectedLines: 1,
  }, '\n');
  ok(!r.ok && /invalid pattern/.test(r.error), 'an unparseable regex fails cleanly');

  // range validation
  ok(!applyLineEdit(LIST, { op: 'move', startLine: 5, endLine: 99, afterLine: 1 }, '\n').ok,
     'an endLine past EOF is refused');
  ok(!applyLineEdit(LIST, { op: 'move', startLine: 7, endLine: 5, afterLine: 1 }, '\n').ok,
     'an inverted range is refused');

  // ---- tool level: the escaping problem this exists to remove ----

  // Content that a shell would mangle: backticks, $var, nested quotes, CJK, emoji.
  // Built from escapes so this source file stays ASCII and the fixture is unambiguous.
  const CJK_HEADING = '## 中文标题 🎯';
  const CJK_BODY = '正文 with `inline` and "quotes"';
  const HOSTILE = [
    '# Escaping',                              // 1
    '',                                        // 2
    '## Block',                                // 3
    '',                                        // 4
    '```powershell',                           // 5
    '$x = "a `b` c"',                          // 6
    "Write-Output '$env:PATH'",                // 7
    '```',                                     // 8
    '',                                        // 9
    CJK_HEADING,                               // 10
    '',                                        // 11
    CJK_BODY,                                  // 12
    '',                                        // 13
  ].join('\n');

  await write(f, HOSTILE);
  let res = await handleEditLines({ file_path: f, op: 'move', startLine: 10, endLine: 12, afterLine: 4 });
  let after = await read(f);
  ok(res.isError !== true, 'move over hostile content succeeds');
  ok(after.includes('$x = "a `b` c"'), 'backticks survive byte-for-byte');
  ok(after.includes("Write-Output '$env:PATH'"), 'dollar-env and single quotes survive');
  ok(after.includes(CJK_HEADING), 'CJK and emoji survive');
  ok(after.includes(CJK_BODY), 'mixed CJK + backticks + quotes survive');
  ok(after.indexOf(CJK_HEADING) < after.indexOf('```powershell'), 'the block actually moved');

  // dry_run writes nothing and previews the same computation
  await write(f, LIST);
  res = await handleEditLines({
    file_path: f, op: 'renumber', startLine: 5, endLine: 8, startAt: 100, dry_run: true,
  });
  ok((await read(f)) === LIST, 'dry_run leaves the file byte-identical');
  ok(/DRY RUN/.test(textOf(res)) && /100\. first/.test(textOf(res)),
     'dry_run previews the exact result it would write');

  // a refused edit writes nothing
  await write(f, LIST);
  res = await handleEditLines({
    file_path: f, op: 'replace_pattern', startLine: 5, endLine: 8,
    pattern: '^(\\d+)', replacement: 'X', expectedLines: 99,
  });
  ok((await read(f)) === LIST, 'a count mismatch writes zero bytes');
  ok(res.isError === true, 'a refused edit is reported as an error');

  // CRLF preservation
  await write(f, LIST.replace(/\n/g, '\r\n'));
  res = await handleEditLines({ file_path: f, op: 'renumber', startLine: 5, endLine: 8, startAt: 7 });
  after = await read(f);
  ok(after.includes('7. first'), 'CRLF file renumbered');
  ok(!/[^\r]\n/.test(after), 'no lone LF introduced into a CRLF file');

  // hashLineRange is EOL-agnostic, so a caller can confirm a range across platforms
  const h1 = hashLineRange(LIST, 5, 8);
  const h2 = hashLineRange(LIST.replace(/\n/g, '\r\n'), 5, 8);
  ok(h1 === h2 && /^sha256:[0-9a-f]{64}$/.test(h1), 'hashLineRange is stable across line endings');

  console.log(`\nAll ${passed} line-edit tests passed`);
}

run()
  .then(async () => { await fs.rm(DIR, { recursive: true, force: true }); process.exit(0); })
  .catch(async (e) => {
    console.error(`\n✗ ${e.message}`);
    await fs.rm(DIR, { recursive: true, force: true });
    process.exit(1);
  });
