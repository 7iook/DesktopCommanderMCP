// Test markdown section addressing: fence-aware heading location + boundary resolution.
// Pure-function module (src/utils/files/markdownSection.ts) — no filesystem needed.
// Auto-discovered by run-all-tests.js (file name starts with "test" and ends with ".js").
import assert from 'assert';
import {
  normalizeHeading,
  splitLines,
  findHeadings,
  resolveSection,
  matchHeadings,
  hashSectionBody,
} from '../dist/utils/files/markdownSection.js';

const c = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m' };
let failures = 0;
let total = 0;

function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`${c.green}  ✓ ${name}${c.reset}`);
  } catch (err) {
    console.log(`${c.red}  ✗ ${name}${c.reset}`);
    const msg = (err && err.message ? err.message : String(err)).split('\n').slice(0, 4).join('\n    ');
    console.log(`${c.red}    ${msg}${c.reset}`);
    failures++;
  }
}

function parse(content) {
  const lines = splitLines(content);
  return { lines, headings: findHeadings(lines) };
}

// Resolve the single section matching `query`; fails loudly on 0 or >1 hits.
function only(content, query) {
  const { lines, headings } = parse(content);
  const hits = matchHeadings(headings, query);
  assert.strictEqual(hits.length, 1, `expected exactly 1 hit for ${JSON.stringify(query)}, got ${hits.length}`);
  return { lines, headings, range: resolveSection(lines, headings, hits[0]) };
}

const at = (headings) => headings.map((h) => h.lineIndex);

console.log(`${c.blue}=== markdown section addressing ===${c.reset}`);

// ---------------------------------------------------------------------------
// 1. Replacing a level-2 section touches only that section's body lines
// ---------------------------------------------------------------------------
check('replacing a level-2 section hits exact body bounds and leaves other lines intact', () => {
  const doc = [
    '# Title',        // 0
    'intro',          // 1
    '## Install',     // 2
    'step one',       // 3
    'step two',       // 4
    '## Usage',       // 5
    'run it',         // 6
  ].join('\n');

  const { lines, range } = only(doc, '## Install');
  assert.strictEqual(range.bodyStart, 3);
  assert.strictEqual(range.bodyEnd, 5, 'bodyEnd is exclusive and points at the next ## line');

  const replaced = [...lines.slice(0, range.bodyStart), 'NEW BODY', ...lines.slice(range.bodyEnd)];
  assert.deepStrictEqual(replaced, ['# Title', 'intro', '## Install', 'NEW BODY', '## Usage', 'run it']);
});

// ---------------------------------------------------------------------------
// 2. Fence awareness — the core correctness requirement
// ---------------------------------------------------------------------------
check('a shell comment inside a ```bash block is not mistaken for a heading', () => {
  const doc = [
    '## Setup',        // 0
    '```bash',         // 1
    '# comment',       // 2  <- must NOT be a heading
    'npm run build',   // 3
    '```',             // 4
    '## Next',         // 5
  ].join('\n');

  const { headings, range } = only(doc, '## Setup');
  assert.deepStrictEqual(headings.map((h) => h.normalized), ['Setup', 'Next']);
  assert.strictEqual(range.bodyEnd, 5, 'section spans the whole fenced block');
});

check('an ATX-looking line inside an info-string-less ``` block is not a heading', () => {
  const { headings } = parse(['## Doc', '```', '## foo', '```', ''].join('\n'));
  assert.deepStrictEqual(headings.map((h) => h.normalized), ['Doc']);
});

check('a tilde fence hides headings and is not closed by backticks', () => {
  const doc = ['## Doc', '~~~', '# inside tilde', '```', '# still inside', '~~~', '## After'].join('\n');
  const { headings } = parse(doc);
  assert.deepStrictEqual(headings.map((h) => h.normalized), ['Doc', 'After'],
    'backtick run must not close a tilde fence');
});

check('a fence indented by up to 3 spaces still opens and closes a code block', () => {
  const doc = ['## Doc', '   ```', '   # indented fence comment', '   ```', '## After'].join('\n');
  const { headings } = parse(doc);
  assert.deepStrictEqual(headings.map((h) => h.normalized), ['Doc', 'After']);
});

check('a 4-space indented line is an indented code block, never a heading', () => {
  const { headings } = parse(['## Doc', '', '    # not a heading', '', '## After'].join('\n'));
  assert.deepStrictEqual(headings.map((h) => h.normalized), ['Doc', 'After']);
});

check('a 4-backtick fence is not closed by a 3-backtick run', () => {
  const doc = [
    '## Doc',        // 0
    '````',          // 1  opener, length 4
    '```',           // 2  too short to close
    '# hidden',      // 3  still fenced
    '```',           // 4  still too short
    '````',          // 5  closes
    '## After',      // 6
  ].join('\n');
  const { headings } = parse(doc);
  assert.deepStrictEqual(headings.map((h) => h.normalized), ['Doc', 'After']);
  assert.deepStrictEqual(at(headings), [0, 6]);
});

check('an inline `code` span in a heading does not open a fence', () => {
  const doc = ['## Use `npm run build`', 'body', '## After'].join('\n');
  const { headings, range } = only(doc, '## Use `npm run build`');
  assert.strictEqual(headings.length, 2);
  assert.strictEqual(range.bodyEnd, 2);
});

// ---------------------------------------------------------------------------
// 3-4. Ambiguity and typos surface as array length, so the caller can fail loudly
// ---------------------------------------------------------------------------
check('a heading appearing twice yields two matches so the caller can refuse to guess', () => {
  const doc = ['## Notes', 'a', '## Other', 'b', '## Notes', 'c'].join('\n');
  const { headings } = parse(doc);
  const hits = matchHeadings(headings, '## Notes');
  assert.strictEqual(hits.length, 2);
  assert.deepStrictEqual(hits.map((i) => headings[i].lineIndex), [0, 4]);
});

check('a mistyped heading yields no matches rather than a near miss', () => {
  const { headings } = parse(['## Install', 'body'].join('\n'));
  assert.deepStrictEqual(matchHeadings(headings, '## Instal'), []);
  assert.deepStrictEqual(matchHeadings(headings, '## install'), [], 'case-sensitive');
});

// ---------------------------------------------------------------------------
// 5. Hierarchy: ## swallows its ### children, stops at the next ## or a #
// ---------------------------------------------------------------------------
check('a level-2 section swallows all nested level-3 subsections', () => {
  const doc = [
    '## Guide',      // 0
    'lead',          // 1
    '### Part A',    // 2
    'a',             // 3
    '#### Deep',     // 4
    'd',             // 5
    '### Part B',    // 6
    'b',             // 7
    '## Appendix',   // 8
    'z',             // 9
  ].join('\n');
  const { range } = only(doc, '## Guide');
  assert.strictEqual(range.bodyStart, 1);
  assert.strictEqual(range.bodyEnd, 8, 'stops at the next ##, not at the first ###');
});

check('a level-2 section stops at a following level-1 heading', () => {
  const doc = ['# One', 'x', '## Sub', 'y', '### Deeper', 'z', '# Two', 'w'].join('\n');
  const { range } = only(doc, '## Sub');
  assert.strictEqual(range.bodyEnd, 6, 'a higher-level heading also terminates the section');
});

check('a level-3 subsection stops at its sibling, not at the parent boundary', () => {
  const doc = ['## Guide', 'lead', '### A', 'a', '### B', 'b', '## After'].join('\n');
  const { range } = only(doc, '### A');
  assert.strictEqual(range.bodyStart, 3);
  assert.strictEqual(range.bodyEnd, 4);
});

// ---------------------------------------------------------------------------
// 6-7. End-of-file and empty sections
// ---------------------------------------------------------------------------
check('the final section in a file ends at lines.length', () => {
  const doc = ['## First', 'a', '## Last', 'x', 'y'].join('\n');
  const { lines, range } = only(doc, '## Last');
  assert.strictEqual(range.bodyEnd, lines.length);
  assert.strictEqual(range.bodyEnd, 5);
});

check('a heading immediately followed by the next heading is an empty section', () => {
  const doc = ['## Empty', '## Next', 'body'].join('\n');
  const { range } = only(doc, '## Empty');
  assert.strictEqual(range.bodyStart, 1);
  assert.strictEqual(range.bodyEnd, 1, 'bodyStart === bodyEnd marks an empty body');
  assert.strictEqual(range.bodyEnd - range.bodyStart, 0);
});

check('a trailing heading with nothing after it is an empty section at EOF', () => {
  const doc = ['## Body', 'x', '## Trailing'].join('\n');
  const { lines, range } = only(doc, '## Trailing');
  assert.strictEqual(range.bodyStart, 3);
  assert.strictEqual(range.bodyEnd, 3);
  assert.strictEqual(range.bodyStart, lines.length);
});

// ---------------------------------------------------------------------------
// 8. normalizeHeading — the four normalization steps + what must NOT be equated
// ---------------------------------------------------------------------------
check('normalizeHeading strips surrounding whitespace', () => {
  assert.strictEqual(normalizeHeading('   Install   '), 'Install');
  assert.strictEqual(normalizeHeading('\t Install \t'), 'Install');
});

check('normalizeHeading strips the leading #{1,6} marker and the space after it', () => {
  assert.strictEqual(normalizeHeading('# Install'), 'Install');
  assert.strictEqual(normalizeHeading('###### Install'), 'Install');
  assert.strictEqual(normalizeHeading('##\tInstall'), 'Install');
  assert.strictEqual(normalizeHeading('  ##   Install'), 'Install');
});

check('normalizeHeading strips an ATX closing sequence', () => {
  assert.strictEqual(normalizeHeading('## Title ##'), 'Title');
  assert.strictEqual(normalizeHeading('## Title #####'), 'Title');
  assert.strictEqual(normalizeHeading('## 标题 ##'), '标题');
});

check('a trailing # that is part of the text is not stripped as a closing sequence', () => {
  // CommonMark: an ATX closing sequence must be preceded by whitespace. `## C#`
  // is a heading whose text is `C#`. Stripping it would collide with `## C`.
  assert.strictEqual(normalizeHeading('## C#'), 'C#');
  assert.strictEqual(normalizeHeading('## C# vs F#'), 'C# vs F#');
  assert.strictEqual(normalizeHeading('## Issue #42#'), 'Issue #42#');
  assert.strictEqual(normalizeHeading('## C++#'), 'C++#');
});

check('a real closing sequence is still stripped off a #-bearing title', () => {
  assert.strictEqual(normalizeHeading('## C# ##'), 'C#', 'space-preceded ## is the closer');
  assert.strictEqual(normalizeHeading('## C#\t#'), 'C#', 'tab counts as the preceding whitespace');
});

check('a # run interrupted by text is left alone', () => {
  assert.strictEqual(normalizeHeading('## a #b'), 'a #b', 'not trailing, so not a closer');
  assert.strictEqual(normalizeHeading('## a ##b'), 'a ##b');
  assert.strictEqual(normalizeHeading('## a #b #'), 'a #b', 'only the trailing run closes');
});

check('a heading whose only text is a closing sequence normalizes to empty', () => {
  assert.strictEqual(normalizeHeading('## #'), '');
  assert.strictEqual(normalizeHeading('## ######'), '');
});

check('`## C#` and `## C` stay addressable as two distinct sections', () => {
  const doc = ['## C#', 'sharp body', '## C', 'plain body', ''].join('\n');
  const { headings } = parse(doc);
  assert.deepStrictEqual(headings.map((h) => h.normalized), ['C#', 'C']);
  assert.deepStrictEqual(matchHeadings(headings, '## C#'), [0], 'C# resolves to exactly one section');
  assert.deepStrictEqual(matchHeadings(headings, '## C'), [1], 'C resolves to exactly one section');
});

check('normalizeHeading collapses internal whitespace runs to one space', () => {
  assert.strictEqual(normalizeHeading('## Getting    Started'), 'Getting Started');
  assert.strictEqual(normalizeHeading('## Getting\t \tStarted'), 'Getting Started');
});

check('a heading written with a closing sequence still matches the plain form', () => {
  const { headings } = parse(['## Title ##', 'body'].join('\n'));
  assert.deepStrictEqual(matchHeadings(headings, '## Title'), [0]);
  assert.deepStrictEqual(matchHeadings(headings, 'Title'), [0], 'query needs no # marker');
});

check('normalizeHeading is case-sensitive', () => {
  assert.notStrictEqual(normalizeHeading('## Install'), normalizeHeading('## install'));
  assert.strictEqual(normalizeHeading('## INSTALL'), 'INSTALL');
});

check('full-width CJK punctuation is never equated with its ASCII counterpart', () => {
  assert.notStrictEqual(normalizeHeading('## 安装，配置'), normalizeHeading('## 安装,配置'));
  assert.notStrictEqual(normalizeHeading('## 用法：说明'), normalizeHeading('## 用法:说明'));
  const { headings } = parse(['## 安装，配置', 'body'].join('\n'));
  assert.deepStrictEqual(matchHeadings(headings, '## 安装,配置'), [],
    'half-width comma must not match a full-width one');
  assert.deepStrictEqual(matchHeadings(headings, '## 安装，配置'), [0]);
});

// ---------------------------------------------------------------------------
// 9. Line-ending independence
// ---------------------------------------------------------------------------
check('splitLines and findHeadings agree across CRLF, LF and lone CR', () => {
  const parts = ['# Title', 'intro', '## Install', 'step', '## Usage', 'run'];
  const lf = parse(parts.join('\n'));
  const crlf = parse(parts.join('\r\n'));
  const cr = parse(parts.join('\r'));

  assert.deepStrictEqual(lf.lines, parts);
  assert.deepStrictEqual(crlf.lines, parts, 'CRLF must not leave a trailing \\r on each line');
  assert.deepStrictEqual(cr.lines, parts);

  const shape = (p) => p.headings.map((h) => `${h.level}:${h.lineIndex}:${h.normalized}`);
  assert.deepStrictEqual(shape(crlf), shape(lf));
  assert.deepStrictEqual(shape(cr), shape(lf));
});

check('section bounds are identical under CRLF and LF', () => {
  const parts = ['# T', 'a', '## Install', 'b', 'c', '## Usage', 'd'];
  const lf = only(parts.join('\n'), '## Install').range;
  const crlf = only(parts.join('\r\n'), '## Install').range;
  assert.deepStrictEqual([crlf.bodyStart, crlf.bodyEnd], [lf.bodyStart, lf.bodyEnd]);
});

check('mixed line endings in one document still split correctly', () => {
  const { lines, headings } = parse('# A\r\nbody\n## B\rtail');
  assert.deepStrictEqual(lines, ['# A', 'body', '## B', 'tail']);
  assert.deepStrictEqual(at(headings), [0, 2]);
});

// ---------------------------------------------------------------------------
// 10. hashSectionBody — the optimistic-concurrency token
// ---------------------------------------------------------------------------
check('hashSectionBody carries the sha256: prefix and a 64-hex digest', () => {
  const { lines, range } = only(['## S', 'body', '## T'].join('\n'), '## S');
  const h = hashSectionBody(lines, range);
  assert.ok(h.startsWith('sha256:'), `expected sha256: prefix, got ${h}`);
  assert.match(h.slice('sha256:'.length), /^[0-9a-f]{64}$/);
});

check('the same body under CRLF and LF hashes identically', () => {
  const parts = ['## Install', 'line one', 'line two', '## Usage', 'x'];
  const lf = only(parts.join('\n'), '## Install');
  const crlf = only(parts.join('\r\n'), '## Install');
  assert.strictEqual(
    hashSectionBody(crlf.lines, crlf.range),
    hashSectionBody(lf.lines, lf.range),
    'a CRLF/LF difference alone must never trip the concurrency token');
});

check('the same body under a lone-CR document hashes identically', () => {
  const parts = ['## Install', 'line one', 'line two', '## Usage', 'x'];
  const lf = only(parts.join('\n'), '## Install');
  const cr = only(parts.join('\r'), '## Install');
  assert.strictEqual(hashSectionBody(cr.lines, cr.range), hashSectionBody(lf.lines, lf.range));
});

check('changing one word in the body changes the hash', () => {
  const before = only(['## S', 'alpha beta', '## T'].join('\n'), '## S');
  const after = only(['## S', 'alpha gamma', '## T'].join('\n'), '## S');
  assert.notStrictEqual(
    hashSectionBody(after.lines, after.range),
    hashSectionBody(before.lines, before.range));
});

check('the heading line itself is outside the hashed body', () => {
  const a = only(['## Name One', 'same body', '## T'].join('\n'), '## Name One');
  const b = only(['## Name Two', 'same body', '## T'].join('\n'), '## Name Two');
  assert.strictEqual(hashSectionBody(a.lines, a.range), hashSectionBody(b.lines, b.range),
    'renaming the heading must not invalidate a body token');
});

check('an empty section hashes to the empty-string digest and is stable', () => {
  const a = only(['## Empty', '## Next'].join('\n'), '## Empty');
  const b = only(['## Empty', '## Other'].join('\n'), '## Empty');
  assert.strictEqual(a.range.bodyStart, a.range.bodyEnd);
  assert.strictEqual(hashSectionBody(a.lines, a.range), hashSectionBody(b.lines, b.range));
});

// ---------------------------------------------------------------------------
// 11. CJK / emoji / inline-code headings match
// ---------------------------------------------------------------------------
check('a Chinese heading matches and resolves its bounds', () => {
  const doc = ['# 文档', '开头', '## 安装步骤', '第一步', '第二步', '## 使用方法', '跑起来'].join('\n');
  const { range } = only(doc, '## 安装步骤');
  assert.strictEqual(range.bodyStart, 3);
  assert.strictEqual(range.bodyEnd, 5);
});

check('an emoji heading matches without mangling surrogate pairs', () => {
  const doc = ['## 🚀 Launch Plan', 'body', '## After'].join('\n');
  const { headings, range } = only(doc, '## 🚀 Launch Plan');
  assert.strictEqual(headings[0].normalized, '🚀 Launch Plan');
  assert.strictEqual(range.bodyEnd, 2);
});

check('a heading containing inline code matches verbatim, backticks included', () => {
  const doc = ['## Run `npm test` first', 'body', '## After'].join('\n');
  const { headings } = parse(doc);
  assert.deepStrictEqual(matchHeadings(headings, '## Run `npm test` first'), [0]);
  assert.deepStrictEqual(matchHeadings(headings, '## Run npm test first'), [],
    'backticks are part of the text, not stripped');
});

check('a mixed CJK + emoji + code heading round-trips through normalization', () => {
  const doc = ['## 部署 🚀 用 `npm run build`', 'body'].join('\n');
  const { headings } = parse(doc);
  assert.deepStrictEqual(matchHeadings(headings, '部署 🚀 用 `npm run build`'), [0]);
});

// ---------------------------------------------------------------------------
// 12. Degenerate documents must not throw
// ---------------------------------------------------------------------------
check('a plain-text file with no headings yields an empty array without throwing', () => {
  const { headings } = parse('just text\nmore text\n\nand more');
  assert.deepStrictEqual(headings, []);
  assert.deepStrictEqual(matchHeadings(headings, '## Anything'), []);
});

check('an empty document yields no headings', () => {
  const { lines, headings } = parse('');
  assert.deepStrictEqual(lines, ['']);
  assert.deepStrictEqual(headings, []);
});

check('a bare # with no text is a heading with an empty normalized name', () => {
  const { headings } = parse(['#', 'body'].join('\n'));
  assert.strictEqual(headings.length, 1);
  assert.strictEqual(headings[0].normalized, '');
});

check('a #-run of 7 or more is not a heading', () => {
  const { headings } = parse(['####### too deep', '## Real'].join('\n'));
  assert.deepStrictEqual(headings.map((h) => h.normalized), ['Real']);
});

check('a #hashtag with no space after the # is not a heading', () => {
  const { headings } = parse(['#hashtag', '## Real'].join('\n'));
  assert.deepStrictEqual(headings.map((h) => h.normalized), ['Real']);
});

check('raw is preserved exactly as it appears on disk', () => {
  const { headings } = parse(['  ##   Spaced   Title  ##', 'body'].join('\n'));
  assert.strictEqual(headings[0].raw, '  ##   Spaced   Title  ##');
  assert.strictEqual(headings[0].normalized, 'Spaced Title');
  assert.strictEqual(headings[0].level, 2);
});

check('an unclosed fence hides every heading to end of file', () => {
  const { headings } = parse(['## Before', '```bash', '# comment', '## not a heading'].join('\n'));
  assert.deepStrictEqual(headings.map((h) => h.normalized), ['Before']);
});

if (failures > 0) {
  console.log(`${c.red}\n${failures} of ${total} failed${c.reset}`);
  process.exit(1);
}
console.log(`${c.green}\nAll ${total} markdown section tests passed${c.reset}`);
process.exit(0);
