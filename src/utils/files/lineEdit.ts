/**
 * Line-range structural editing — move, renumber, and per-line pattern replacement.
 *
 * WHY THIS EXISTS
 * edit_block replaces a fixed string; write_file rewrites a whole file. Neither can
 * reorder lines, resequence a numbered list, or apply one regex down a bounded range.
 * An agent that needs those has had exactly one route: shell out to PowerShell/Python.
 *
 * That route is where the time goes. In a real 6-round spec review the agent hit
 * PowerShell backtick escaping three separate times on the same task -- its own note the
 * third time reads "backticks eaten by PowerShell (third time in the same trap)" -- and
 * each recovery meant abandoning the tool, writing a throwaway script file, running it,
 * then deleting it. Six such scripts accumulated in that one session
 * (renumber_r2.py, fix_matrix_r3.py, fix_props_r5.py, fix_r5_env.py, fix_wf.py,
 * dead_scheme_scan.py). None of them did anything conceptually hard; they existed only
 * because the edit tools could not express "move these lines" or "renumber this block".
 *
 * Content here never touches a shell: it arrives as MCP tool arguments and is written with
 * fs.writeFile. Backticks, `$env:VAR`, nested quotes and CJK text are bytes like any other.
 *
 * SCOPE: line-structural operations on text files. Deliberately NOT another way to do
 * string replacement -- edit_block owns that, including its fuzzy-match diagnostics.
 */

import { createHash } from 'crypto';
import { splitLines } from './markdownSection.js';

export type LineOp = 'move' | 'renumber' | 'replace_pattern';

export interface LineEditRequest {
    op: LineOp;
    /** 1-based inclusive start of the range this op reads or rewrites. */
    startLine: number;
    /** 1-based inclusive end. Must be >= startLine. */
    endLine: number;
    /**
     * move: 1-based line number the block lands AFTER, in ORIGINAL coordinates.
     * 0 means "move to the very top of the file".
     */
    afterLine?: number;
    /**
     * renumber: the sequence's first value (default 1).
     * Lines matching `^(\s*)(\d+)([.)])` inside the range are resequenced in order;
     * every other line, including blanks and continuations, is left untouched.
     */
    startAt?: number;
    /** replace_pattern: JS regex source, applied per line within the range. */
    pattern?: string;
    /** replace_pattern: flags. `g` is added automatically; `m` and `s` are rejected. */
    flags?: string;
    /** replace_pattern: replacement string, supports $1 group references. */
    replacement?: string;
    /**
     * replace_pattern: exact number of LINES expected to change. Required.
     * A count mismatch aborts with zero bytes written -- the same contract as
     * edit_block's expected_replacements, and for the same reason: a regex that
     * silently matches more than the caller believed is how bulk edits do damage.
     */
    expectedLines?: number;
}

export interface LineEditOutcome {
    ok: boolean;
    /** Human-readable reason when ok is false. */
    error?: string;
    /** Lines actually changed/moved, for the caller's report. */
    linesAffected: number;
    /** Unified-style preview of what changed, always populated on success. */
    preview: string[];
    /** The resulting file content; undefined when ok is false. */
    content?: string;
}

/** Regexes that can span or consume lines break the per-line contract. */
function validateFlags(flags: string | undefined): string | null {
    if (!flags) return null;
    for (const f of flags) {
        if (f === 'm' || f === 's') {
            return `flag "${f}" is not allowed: this op applies the pattern per line, ` +
                   'so multiline/dotAll would make the range boundaries meaningless';
        }
        if (!'gimsuy'.includes(f)) return `unknown regex flag "${f}"`;
    }
    return null;
}

function clampCheck(req: LineEditRequest, total: number): string | null {
    if (!Number.isInteger(req.startLine) || !Number.isInteger(req.endLine)) {
        return 'startLine and endLine must be integers';
    }
    if (req.startLine < 1) return `startLine ${req.startLine} is below 1`;
    if (req.endLine < req.startLine) {
        return `endLine ${req.endLine} is before startLine ${req.startLine}`;
    }
    if (req.endLine > total) {
        return `endLine ${req.endLine} is past end of file (${total} lines)`;
    }
    return null;
}

/** Compact before/after listing. Truncated so a large move does not flood the caller. */
function buildPreview(before: string[], after: string[], limit = 12): string[] {
    const out: string[] = [];
    let shown = 0;
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max && shown < limit; i++) {
        const b = before[i];
        const a = after[i];
        if (b === a) continue;
        if (b !== undefined) out.push(`- ${b}`);
        if (a !== undefined) out.push(`+ ${a}`);
        shown++;
    }
    const remaining = countDiff(before, after) - shown;
    if (remaining > 0) out.push(`  … ${remaining} more changed line(s)`);
    return out;
}

function countDiff(a: string[], b: string[]): number {
    let n = 0;
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) if (a[i] !== b[i]) n++;
    return n;
}

/**
 * Apply one line-structural op to file content.
 *
 * Pure: takes and returns strings, so the caller owns all I/O and locking. The op is
 * computed against the content it was given, which is what makes a dry run and the real
 * write provably identical.
 */
export function applyLineEdit(content: string, req: LineEditRequest, lineEnding: string): LineEditOutcome {
    const lines = splitLines(content);
    const fail = (error: string): LineEditOutcome => ({ ok: false, error, linesAffected: 0, preview: [] });

    const rangeErr = clampCheck(req, lines.length);
    if (rangeErr) return fail(rangeErr);

    const from = req.startLine - 1;          // 0-based inclusive
    const to = req.endLine;                  // 0-based exclusive
    const before = lines.slice();

    if (req.op === 'move') {
        if (req.afterLine === undefined || !Number.isInteger(req.afterLine)) {
            return fail('move requires an integer afterLine (0 = top of file)');
        }
        if (req.afterLine < 0 || req.afterLine > lines.length) {
            return fail(`afterLine ${req.afterLine} is outside 0..${lines.length}`);
        }
        // Landing inside the block being moved has no single sensible meaning, and
        // guessing one is how a "reorder" silently shuffles content.
        if (req.afterLine >= req.startLine - 1 && req.afterLine < req.endLine) {
            return fail(
                `afterLine ${req.afterLine} falls inside the moved range ` +
                `${req.startLine}..${req.endLine} — pick a destination outside it`
            );
        }

        const block = lines.slice(from, to);
        const rest = [...lines.slice(0, from), ...lines.slice(to)];
        // afterLine is in ORIGINAL coordinates; translate to an index in `rest`.
        const insertAt = req.afterLine <= from ? req.afterLine : req.afterLine - block.length;
        const after = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];

        return {
            ok: true,
            linesAffected: block.length,
            preview: buildPreview(before, after),
            content: after.join(lineEnding),
        };
    }

    if (req.op === 'renumber') {
        const startAt = req.startAt ?? 1;
        if (!Number.isInteger(startAt) || startAt < 0) return fail('startAt must be a non-negative integer');

        const after = lines.slice();
        // Only the leading "N." / "N)" token is rewritten. Indentation is captured and
        // restored so a nested list keeps its shape, and the delimiter is echoed back
        // rather than normalized -- rewriting "1)" as "1." would be an unrequested change.
        const itemRe = /^(\s*)(\d+)([.)])(\s|$)/;
        let seq = startAt;
        let touched = 0;
        for (let i = from; i < to; i++) {
            const m = after[i].match(itemRe);
            if (!m) continue;
            const rebuilt = `${m[1]}${seq}${m[3]}${m[4]}` + after[i].slice(m[0].length);
            if (rebuilt !== after[i]) touched++;
            after[i] = rebuilt;
            seq++;
        }
        const numbered = seq - startAt;
        if (numbered === 0) {
            return fail(`no numbered items found in lines ${req.startLine}..${req.endLine}`);
        }
        if (req.expectedLines !== undefined && numbered !== req.expectedLines) {
            return fail(
                `found ${numbered} numbered item(s) but expectedLines=${req.expectedLines} — ` +
                're-read the range and retry'
            );
        }

        return {
            ok: true,
            linesAffected: touched,
            preview: buildPreview(before, after),
            content: after.join(lineEnding),
        };
    }

    if (req.op === 'replace_pattern') {
        if (!req.pattern) return fail('replace_pattern requires a pattern');
        if (req.replacement === undefined) return fail('replace_pattern requires a replacement');
        if (req.expectedLines === undefined || !Number.isInteger(req.expectedLines)) {
            return fail(
                'replace_pattern requires expectedLines (the exact number of lines you expect ' +
                'to change) — an unbounded regex over a range is how bulk edits cause damage'
            );
        }
        const flagErr = validateFlags(req.flags);
        if (flagErr) return fail(flagErr);

        let re: RegExp;
        try {
            const flags = (req.flags ?? '').includes('g') ? req.flags! : `${req.flags ?? ''}g`;
            re = new RegExp(req.pattern, flags);
        } catch (e) {
            return fail(`invalid pattern: ${e instanceof Error ? e.message : String(e)}`);
        }

        const after = lines.slice();
        let changed = 0;
        for (let i = from; i < to; i++) {
            re.lastIndex = 0;
            const next = after[i].replace(re, req.replacement);
            if (next !== after[i]) {
                after[i] = next;
                changed++;
            }
        }
        if (changed !== req.expectedLines) {
            return fail(
                `pattern changed ${changed} line(s) but expectedLines=${req.expectedLines}` +
                (changed === 0
                    ? ' — the pattern matched nothing in this range'
                    : ' — narrow the range or the pattern, or set expectedLines to the real count')
            );
        }

        return {
            ok: true,
            linesAffected: changed,
            preview: buildPreview(before, after),
            content: after.join(lineEnding),
        };
    }

    return fail(`unknown op "${(req as LineEditRequest).op}"`);
}

/** sha256 of a line range, for callers that want to confirm what they read. */
export function hashLineRange(content: string, startLine: number, endLine: number): string {
    const lines = splitLines(content);
    const slice = lines.slice(startLine - 1, endLine);
    return 'sha256:' + createHash('sha256').update(slice.join('\n'), 'utf8').digest('hex');
}
