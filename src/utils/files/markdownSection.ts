/**
 * Markdown section addressing — fence-aware heading location and boundary resolution.
 *
 * WHY THIS EXISTS
 * `old_string` editing requires the caller to hold a byte-exact copy of the text being
 * replaced. For whole-section rewrites that means quoting 40+ lines verbatim, where a
 * single full-width comma, trailing space or CRLF drift fails the edit. Addressing a
 * section by its heading line removes that precondition entirely: only one line is matched,
 * and the section's end boundary is computed here rather than supplied by the caller.
 *
 * SCOPE: markdown/plain-text only. Code-file (function-level) addressing is explicitly
 * out of scope — that needs language parsing and is a different risk class.
 *
 * Decision card: .agent-workspace/.archive/2026-08-05/md-section-edit/
 *                md-section-edit-decision-card.md
 */

import { createHash } from 'crypto';

/** Heading levels 1-6 (`#` through `######`). */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface HeadingInfo {
    /** 0-based index into the line array. */
    lineIndex: number;
    /** 1-6, from the count of leading `#`. */
    level: HeadingLevel;
    /** Heading text after normalization (see normalizeHeading). */
    normalized: string;
    /** The heading line exactly as it appears on disk. */
    raw: string;
}

export interface SectionRange {
    heading: HeadingInfo;
    /** 0-based, inclusive — first body line (the line AFTER the heading). */
    bodyStart: number;
    /**
     * 0-based, EXCLUSIVE — one past the last body line. Equals bodyStart for an
     * empty section. Equals lines.length for the final section in the file.
     */
    bodyEnd: number;
}

/**
 * Normalize a heading for comparison — THE single authoritative algorithm.
 *
 * Applied identically to the caller's `range` argument and to every heading line in the
 * file; two competing normalization rules would produce different hits for the same input
 * (review R2-DC5), so this function is the only place the rules live.
 *
 * 1. strip leading/trailing whitespace
 * 2. strip the optional leading `#{1,6}` and the whitespace after it
 * 3. strip an ATX closing sequence — a trailing `#+` run that is either preceded by
 *    whitespace or is the entire remaining text (CommonMark). The whitespace requirement
 *    is load-bearing: without it `## C#` normalizes to `C` and collides with a real
 *    `## C` section, so one query matches two headings and neither is addressable.
 * 4. collapse internal whitespace runs to a single space
 *
 * Case-SENSITIVE. No Unicode normalization (NFC/NFKC) — CJK full-width punctuation is
 * compared by raw code point, so `，` never equals `,`.
 */
export function normalizeHeading(text: string): string {
    let s = text.trim();
    s = s.replace(/^#{1,6}[ \t]*/, '');
    s = s.replace(/(^|[ \t])[ \t]*#+$/, '');
    return s.replace(/[ \t]+/g, ' ');
}

/**
 * Split content into lines, preserving no line endings.
 *
 * Handles CRLF, LF and lone CR. The caller reassembles with the file's detected ending
 * (see utils/lineEndingHandler.ts) so the original style survives a round trip.
 */
export function splitLines(content: string): string[] {
    return content.split(/\r\n|\n|\r/);
}

/**
 * Find every ATX heading in the document, skipping fenced code blocks.
 *
 * FENCE AWARENESS IS THE CORE CORRECTNESS REQUIREMENT: a naive `/^#{1,6} /` scan treats
 * `# comment` inside a ```bash block as a heading, which shifts every subsequent section
 * boundary and silently truncates or over-extends the replacement. Spec documents are full
 * of shell snippets, so this is the common case, not an edge case.
 *
 * Fence rules implemented (CommonMark subset):
 * - openers: >=3 backticks or >=3 tildes, optionally indented up to 3 spaces
 * - a closing fence must use the same character and be at least as long as the opener,
 *   and carries no info string
 * - a tilde fence is not closed by backticks and vice versa
 * - 4+ space indented lines are NOT treated as headings (indented code block)
 *
 * Setext headings (`===` / `---` underlines) are deliberately NOT located — they are only
 * required not to be mistaken for body content. Out of scope per the decision card.
 */
export function findHeadings(lines: string[]): HeadingInfo[] {
    const headings: HeadingInfo[] = [];
    let fenceChar: '`' | '~' | null = null;
    let fenceLen = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);

        if (fence) {
            const marker = fence[1];
            const char = marker[0] as '`' | '~';
            const info = fence[2];

            if (fenceChar === null) {
                // Opening fence. A backtick opener's info string may not contain a
                // backtick (CommonMark), which keeps inline `code` spans from opening one.
                if (char === '`' && info.includes('`')) continue;
                fenceChar = char;
                fenceLen = marker.length;
                continue;
            }

            // Inside a fence: only the same char, >= opener length, no info string closes it.
            if (char === fenceChar && marker.length >= fenceLen && info.trim() === '') {
                fenceChar = null;
                fenceLen = 0;
            }
            continue;
        }

        if (fenceChar !== null) continue;      // fenced body — never a heading
        if (/^ {4,}/.test(line)) continue;     // indented code block

        const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
        if (!m) continue;

        headings.push({
            lineIndex: i,
            level: m[1].length as HeadingLevel,
            normalized: normalizeHeading(m[2] ?? ''),
            raw: line,
        });
    }

    return headings;
}

/**
 * Resolve a section's body boundary: from just after the heading up to the next heading of
 * the SAME OR HIGHER level (i.e. `##` swallows its `###` children), or EOF for the last
 * section. This hierarchical rule is what makes "replace this section" match a reader's
 * intuition rather than stopping at the first subheading.
 */
export function resolveSection(lines: string[], headings: HeadingInfo[], index: number): SectionRange {
    const heading = headings[index];
    let bodyEnd = lines.length;

    for (let j = index + 1; j < headings.length; j++) {
        if (headings[j].level <= heading.level) {
            bodyEnd = headings[j].lineIndex;
            break;
        }
    }

    return { heading, bodyStart: heading.lineIndex + 1, bodyEnd };
}

/** All headings whose normalized text equals the normalized query. */
export function matchHeadings(headings: HeadingInfo[], query: string): number[] {
    const target = normalizeHeading(query);
    const out: number[] = [];
    for (let i = 0; i < headings.length; i++) {
        if (headings[i].normalized === target) out.push(i);
    }
    return out;
}

/**
 * Hash of a section's body, used as the optimistic-concurrency token.
 *
 * Section mode drops `old_string`'s implicit compare-before-write, so without this a stale
 * caller silently overwrites whatever a colleague or another agent wrote in the meantime —
 * the failure mode degrades from "loud mismatch" to "silent clobber" (review DC1). The hash
 * is computed over LF-joined body lines so a CRLF/LF difference alone never trips it.
 */
export function hashSectionBody(lines: string[], range: SectionRange): string {
    const body = lines.slice(range.bodyStart, range.bodyEnd).join('\n');
    return 'sha256:' + createHash('sha256').update(body, 'utf8').digest('hex');
}
