/**
 * edit_block_multiple — markdown SECTION mode.
 *
 * Covers the batch semantics that section addressing needs and old_string does not:
 * up-front resolution against one read, back-to-front splicing, overlap rejection,
 * the mandatory staleness token, and mixing both modes in one call.
 */
import path from 'path';
import fs from 'fs/promises';
import assert from 'assert';
import { fileURLToPath } from 'url';
import { editBlockMultiple } from '../dist/tools/edit.js';
import { hashSectionBody, splitLines, findHeadings, resolveSection } from '../dist/utils/files/markdownSection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '_tmp-section-batch');

let passed = 0;
const ok = (cond, name) => {
  assert.ok(cond, name);
  console.log(`  ✓ ${name}`);
  passed++;
};

const write = (p, s) => fs.writeFile(p, s, 'utf8');
const read = (p) => fs.readFile(p, 'utf8');
const textOf = (res) => res.content.map(c => c.text).join('\n');

/** sha256 of a section body, the way a caller would compute it after reading. */
async function hashOf(file, heading) {
  const lines = splitLines(await read(file));
  const hs = findHeadings(lines);
  const i = hs.findIndex(h => h.normalized === heading.replace(/^#+\s*/, ''));
  assert.ok(i >= 0, `fixture heading not found: ${heading}`);
  return hashSectionBody(lines, resolveSection(lines, hs, i));
}

const DOC = [
  '# Title',
  '',
  'intro line',
  '',
  '## Alpha',
  '',
  'alpha body',
  '',
  '### Alpha Child',
  '',
  'child body',
  '',
  '## Beta',
  '',
  'beta body',
  '',
  '## Gamma',
  '',
  'gamma body',
  '',
].join('\n');

async function run() {
  await fs.mkdir(DIR, { recursive: true });
  const f = path.join(DIR, 'doc.md');
  const g = path.join(DIR, 'other.md');

  // --- 1: two sections in one call, no old body quoted anywhere ---
  await write(f, DOC);
  let res = await editBlockMultiple([
    { file_path: f, range: '## Beta', content: '\nbeta REWRITTEN\n', expected_section_hash: await hashOf(f, '## Beta') },
    { file_path: f, range: '## Gamma', content: '\ngamma REWRITTEN\n', expected_section_hash: await hashOf(f, '## Gamma') },
  ]);
  let after = await read(f);
  ok(after.includes('beta REWRITTEN') && after.includes('gamma REWRITTEN'), 'two sections rewritten in a single call');
  ok(after.includes('## Beta') && after.includes('## Gamma'), 'heading lines themselves survive');
  ok(after.includes('alpha body') && after.includes('child body') && after.includes('intro line'),
     'untouched sections are left intact');
  ok(!after.includes('beta body') && !after.includes('gamma body'), 'old bodies are gone, not appended to');

  // --- 2: back-to-front application — the earlier section must not shift the later one ---
  await write(f, DOC);
  res = await editBlockMultiple([
    // deliberately listed in document order, with a body that changes line count
    { file_path: f, range: '## Alpha', content: '\nA1\nA2\nA3\nA4\nA5\n', expected_section_hash: await hashOf(f, '## Alpha') },
    { file_path: f, range: '## Gamma', content: '\nG1\n', expected_section_hash: await hashOf(f, '## Gamma') },
  ]);
  after = await read(f);
  ok(/## Alpha\r?\n\r?\nA1\r?\nA2\r?\nA3\r?\nA4\r?\nA5/.test(after), 'first section body replaced exactly');
  ok(/## Gamma\r?\n\r?\nG1/.test(after), 'later section still landed correctly despite the earlier size change');
  ok(!after.includes('gamma body'), 'no stale remnant of the later section');

  // --- 3: a `##` swallows its `###` child ---
  await write(f, DOC);
  res = await editBlockMultiple([
    { file_path: f, range: '## Alpha', content: '\nonly alpha now\n', expected_section_hash: await hashOf(f, '## Alpha') },
  ]);
  after = await read(f);
  ok(!after.includes('### Alpha Child') && !after.includes('child body'),
     'replacing a parent section removes its subsections too');
  ok(after.includes('## Beta'), 'the next same-level heading bounds the replacement');

  // --- 4: overlap (parent + its own child) is rejected before any write ---
  await write(f, DOC);
  const hAlpha = await hashOf(f, '## Alpha');
  const hChild = await hashOf(f, '### Alpha Child');
  res = await editBlockMultiple([
    { file_path: f, range: '## Alpha', content: '\nx\n', expected_section_hash: hAlpha },
    { file_path: f, range: '### Alpha Child', content: '\ny\n', expected_section_hash: hChild },
  ]);
  ok((await read(f)) === DOC, 'overlapping targets leave the file byte-identical');
  ok(/overlapping_sections/.test(textOf(res)), 'overlap is reported as overlapping_sections');

  // --- 5: the staleness token is mandatory ---
  await write(f, DOC);
  res = await editBlockMultiple([{ file_path: f, range: '## Beta', content: '\nnope\n' }]);
  ok((await read(f)) === DOC, 'a missing hash writes nothing');
  ok(/missing_section_hash/.test(textOf(res)), 'missing hash is named explicitly');

  // --- 6: a stale token is refused (this is the concurrency guard) ---
  await write(f, DOC);
  const staleHash = await hashOf(f, '## Beta');
  await write(f, DOC.replace('beta body', 'beta body edited by someone else'));
  res = await editBlockMultiple([
    { file_path: f, range: '## Beta', content: '\nclobber\n', expected_section_hash: staleHash },
  ]);
  after = await read(f);
  ok(after.includes('edited by someone else'), "a concurrent edit is NOT clobbered");
  ok(!after.includes('clobber'), 'the stale write did not land');
  ok(/stale_section/.test(textOf(res)), 'staleness is reported as stale_section');

  // --- 7: unknown / ambiguous headings ---
  await write(f, DOC);
  res = await editBlockMultiple([
    { file_path: f, range: '## Nonexistent', content: '\nx\n', expected_section_hash: 'sha256:whatever' },
  ]);
  ok((await read(f)) === DOC, 'unknown heading writes nothing');
  ok(/heading not found/.test(textOf(res)), 'unknown heading is reported');

  const DUP = '# T\n\n## Dup\n\none\n\n## Dup\n\ntwo\n';
  await write(g, DUP);
  res = await editBlockMultiple([
    { file_path: g, range: '## Dup', content: '\nx\n', expected_section_hash: 'sha256:whatever' },
  ]);
  ok((await read(g)) === DUP, 'ambiguous heading writes nothing');
  ok(/not unique/.test(textOf(res)) && /use old_string/.test(textOf(res)),
     'ambiguity points the caller at old_string rather than promising a narrow-down');

  // --- 8: per-file atomicity across the two modes ---
  await write(f, DOC);
  res = await editBlockMultiple([
    { file_path: f, range: '## Beta', content: '\nfine\n', expected_section_hash: await hashOf(f, '## Beta') },
    { file_path: f, old_string: 'NOT PRESENT ANYWHERE', new_string: 'x' },
  ]);
  ok((await read(f)) === DOC, 'a failing text edit rolls back a section edit in the same file');

  // --- 9: both modes succeeding together ---
  await write(f, DOC);
  res = await editBlockMultiple([
    { file_path: f, range: '## Beta', content: '\nbeta via section\n', expected_section_hash: await hashOf(f, '## Beta') },
    { file_path: f, old_string: 'intro line', new_string: 'intro CHANGED' },
  ]);
  after = await read(f);
  ok(after.includes('beta via section') && after.includes('intro CHANGED'),
     'section mode and old_string mode compose in one call');

  // --- 10: CRLF preserved ---
  await write(f, DOC.replace(/\n/g, '\r\n'));
  res = await editBlockMultiple([
    { file_path: f, range: '## Beta', content: '\ncrlf body\n', expected_section_hash: await hashOf(f, '## Beta') },
  ]);
  after = await read(f);
  ok(after.includes('crlf body'), 'CRLF file edited');
  ok(!/[^\r]\n/.test(after), 'no lone LF introduced into a CRLF file');

  // --- 11: emptying a section keeps its heading ---
  await write(f, DOC);
  res = await editBlockMultiple([
    { file_path: f, range: '## Beta', content: '', expected_section_hash: await hashOf(f, '## Beta') },
  ]);
  after = await read(f);
  ok(after.includes('## Beta') && !after.includes('beta body'), 'empty content clears the body but keeps the heading');

  // --- 12: fence awareness end to end ---
  const FENCED = ['# T', '', '```bash', '# not a heading', 'echo hi', '```', '', '## Real', '', 'real body', ''].join('\n');
  await write(g, FENCED);
  res = await editBlockMultiple([
    { file_path: g, range: '## Real', content: '\nreplaced\n', expected_section_hash: await hashOf(g, '## Real') },
  ]);
  after = await read(g);
  ok(after.includes('# not a heading') && after.includes('echo hi'),
     'a # comment inside a fence is not treated as a heading boundary');
  ok(after.includes('replaced') && !after.includes('real body'), 'the real section was the one replaced');

  // --- 13: a near-miss heading gets a suggestion (edit_block's single-edit path) ---
  // Regression lock for a defect found in end-to-end testing: with a 0.5 cut-off and a pure
  // bigram ratio, "## Beta Section" produced NO hint even though "## Beta" was right there,
  // costing the caller another wrong round-trip — the very churn section mode exists to remove.
  const { TextFileHandler } = await import('../dist/utils/files/text.js');
  const handler = new TextFileHandler();
  await write(f, DOC);

  let r = await handler.editRange(f, '## Beta Section', '\nx\n', { expected_section_hash: 'sha256:whatever' });
  let msg = r.errors.map(e => e.error).join('\n');
  ok(r.success === false, 'a near-miss heading still fails rather than guessing');
  ok(/closest headings/.test(msg), 'a near-miss heading now yields suggestions');
  ok(/## Beta/.test(msg), 'the actual heading is named in the suggestions');
  ok((await read(f)) === DOC, 'suggesting a heading writes nothing');

  r = await handler.editRange(f, '## Bета', '\nx\n', { expected_section_hash: 'sha256:whatever' });
  ok(r.success === false, 'a heading with lookalike characters does not match');

  r = await handler.editRange(f, '## Zzzzzzz Qqqqqqq', '\nx\n', { expected_section_hash: 'sha256:whatever' });
  msg = r.errors.map(e => e.error).join('\n');
  ok(!/closest headings/.test(msg), 'a heading with nothing in common yields no misleading suggestion');

  console.log(`\nAll ${passed} section-batch tests passed`);
}

run()
  .then(async () => { await fs.rm(DIR, { recursive: true, force: true }); process.exit(0); })
  .catch(async (e) => {
    console.error(`\n✗ ${e.message}`);
    await fs.rm(DIR, { recursive: true, force: true });
    process.exit(1);
  });
