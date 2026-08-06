/**
 * Leftover detection — after a section edit, does the file still say the old thing elsewhere?
 *
 * The defect this targets is the expensive one in multi-round document work: the edit lands,
 * a stale copy of the same claim survives in another section, and nothing notices until the
 * next review round re-reports it. One real 6-round review hit it five times.
 *
 * Precision is the thing under test, not recall. A check that fires on every edit gets
 * ignored, and an ignored warning is worse than no warning — so the negative cases below
 * (common words, vocabulary that legitimately recurs) matter as much as the positive ones.
 */
import path from 'path';
import fs from 'fs/promises';
import assert from 'assert';
import { fileURLToPath } from 'url';
import {
  extractSignificantTokens,
  findLeftovers,
  formatLeftovers,
} from '../dist/utils/files/leftoverScan.js';
import { TextFileHandler } from '../dist/utils/files/text.js';
import { hashSectionBody, splitLines, findHeadings, resolveSection } from '../dist/utils/files/markdownSection.js';
import { configManager } from '../dist/config-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '_tmp-leftover');

let passed = 0;
const ok = (cond, name) => {
  assert.ok(cond, name);
  console.log(`  ${'✓'} ${name}`);
  passed++;
};

const write = (p, s) => fs.writeFile(p, s, 'utf8');
const read = (p) => fs.readFile(p, 'utf8');

async function hashOf(file, heading) {
  const lines = splitLines(await read(file));
  const hs = findHeadings(lines);
  const i = hs.findIndex(h => h.normalized === heading.replace(/^#+\s*/, ''));
  assert.ok(i >= 0, `fixture heading not found: ${heading}`);
  return hashSectionBody(lines, resolveSection(lines, hs, i));
}

async function runCases(f) {
  // ---- token extraction: the precision mechanism ----

  let t = extractSignificantTokens('call strip_admin_capability on every delegate');
  ok(t.includes('strip_admin_capability'), 'snake_case identifier is extracted');

  t = extractSignificantTokens('see web_backend_delegate.py for the wiring');
  ok(t.some(x => x.includes('web_backend_delegate')), 'a dotted filename is extracted');

  t = extractSignificantTokens('the getUserToken helper is gone');
  ok(t.includes('getUserToken'), 'camelCase identifier is extracted');

  t = extractSignificantTokens('use the `expected_section_hash` field');
  ok(t.includes('expected_section_hash'), 'a backtick span is extracted');

  t = extractSignificantTokens('旧方案是 token 免握手直接放行');
  ok(t.some(x => x.includes('免握手')), 'a CJK phrase of 4+ chars is extracted');

  // Negative cases — these are what keep the report readable.
  t = extractSignificantTokens('the value should return true when data is null');
  ok(t.length === 0, 'plain English prose yields no tokens');

  t = extractSignificantTokens('see item 2.14 and item 2.15 in the table');
  ok(!t.includes('2.14') && !t.includes('2.15'),
     'bare numbers are not tokens — they recur legitimately in numbered documents');

  t = extractSignificantTokens('a b c de');
  ok(t.length === 0, 'short fragments yield nothing');

  t = extractSignificantTokens('中文短语');
  ok(t.length === 0 || !t.includes('中文'), 'a CJK run under 4 chars is not a token');

  // ---- findLeftovers ----

  const DOC = [
    '# Doc',                                       // 1
    '',                                            // 2
    '## Design',                                   // 3
    '',                                            // 4
    'every delegate calls strip_admin_capability', // 5
    '',                                            // 6
    '## Layering table',                           // 7
    '',                                            // 8
    'all services call strip_admin_capability',    // 9
    '',                                            // 10
    '## Test matrix',                              // 11
    '',                                            // 12
    'assert strip_admin_capability is applied',    // 13
    '',                                            // 14
  ].join('\n');

  let lo = findLeftovers(
    'every delegate calls strip_admin_capability',
    DOC.replace('every delegate calls strip_admin_capability', 'BFF is excluded now'),
    3, 5,
  );
  ok(lo.length >= 1, 'a name surviving in other sections is reported');
  ok(lo[0].token === 'strip_admin_capability', 'the surviving name is identified');
  ok(lo[0].lines.includes(9) && lo[0].lines.includes(13),
     'both remaining mentions are located (the layering table AND the test matrix)');

  // The edited region itself must never be reported back.
  lo = findLeftovers('calls strip_admin_capability', DOC, 3, 5);
  ok(!lo.some(x => x.lines.includes(5)), 'a hit inside the edited region is not reported');

  // Nothing surviving -> silence.
  lo = findLeftovers('a totally unique_name_xyz9 here', DOC, 1, 2);
  ok(lo.length === 0, 'a name that survives nowhere produces no note');

  // Rarest-first ordering: the single mention is the likelier stale copy.
  const DOC2 = [
    'x common_helper a', 'y common_helper b', 'z common_helper c', 'only rare_thing here',
  ].join('\n');
  lo = findLeftovers('drop common_helper and rare_thing', DOC2, 0, 0);
  ok(lo.length === 2 && lo[0].token === 'rare_thing',
     'the rarer surviving name is ranked first');

  ok(formatLeftovers([]).length === 0, 'nothing to report renders no output');
  const rendered = formatLeftovers(lo).join('\n');
  ok(/may be intentional/.test(rendered),
     'the report says a hit may be deliberate rather than asserting a defect');

  // ---- end to end through the section-edit path ----

  await write(f, DOC);
  const handler = new TextFileHandler();
  let res = await handler.editRange(f, '## Design', '\nBFF is explicitly excluded\n', {
    expected_section_hash: await hashOf(f, '## Design'),
  });
  ok(res.success === true, 'the section edit still succeeds');
  ok(Array.isArray(res.notes) && res.notes.length > 0, 'notes are attached to the result');
  const noteText = res.notes.join('\n');
  ok(/strip_admin_capability/.test(noteText), 'the note names the surviving identifier');
  ok(/L9|L13/.test(noteText), 'the note gives line numbers to check');
  ok((await read(f)).includes('BFF is explicitly excluded'), 'the edit itself landed');

  // A note is advisory: it must not turn a success into a failure.
  ok(res.errors === undefined, 'a leftover note is not reported as an error');

  // No leftovers -> no notes key at all, so callers can test for its absence.
  const CLEAN = ['# C', '', '## One', '', 'unique_alpha_thing', '', '## Two', '', 'unrelated', ''].join('\n');
  await write(f, CLEAN);
  res = await handler.editRange(f, '## One', '\nreplaced entirely\n', {
    expected_section_hash: await hashOf(f, '## One'),
  });
  ok(res.success === true && res.notes === undefined,
     'an edit with nothing surviving carries no notes');

  console.log(`\nAll ${passed} leftover-scan tests passed`);
}

async function run() {
  await fs.mkdir(DIR, { recursive: true });
  // The suite shares one config file and earlier modules narrow allowedDirectories to their
  // own fixture dirs; without claiming ours, validatePath rejects this file.
  const priorAllowed = (await configManager.getConfig()).allowedDirectories;
  await configManager.setValue('allowedDirectories', [DIR]);
  try {
    await runCases(path.join(DIR, 'doc.md'));
  } finally {
    await configManager.setValue('allowedDirectories', priorAllowed);
  }
}

run()
  .then(async () => { await fs.rm(DIR, { recursive: true, force: true }); process.exit(0); })
  .catch(async (e) => {
    console.error(`\n${'✗'} ${e.message}`);
    await fs.rm(DIR, { recursive: true, force: true });
    process.exit(1);
  });
