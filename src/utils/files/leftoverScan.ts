/**
 * Leftover detection — after an edit, report where else the file still says the old thing.
 *
 * WHY THIS EXISTS
 * The expensive failure in multi-round document work is not the edit that fails; it is the
 * edit that succeeds while leaving the same claim standing somewhere else. In one real
 * 6-round spec review the author hit this five times and said so plainly: "fifth time I've
 * been burned by only editing the main design without a full re-scan". The cost is not the
 * missed line, it is that nothing notices until the NEXT review round, which then spends
 * itself re-reporting a defect that was supposed to be fixed.
 *
 * What made those misses findable after the fact was always the same move: take a
 * distinctive name out of the text that was just removed, and grep the rest of the file for
 * it. `strip_admin_capability`, `web_backend_delegate.py`, `token 免握手` — each was a
 * specific enough string that a single search would have surfaced the other mentions. That
 * is cheap and mechanical, so it belongs in the tool rather than in the agent's memory.
 *
 * WHAT THIS DOES NOT DO
 * It makes no judgement. A hit can be a genuine leftover, a historical note ("superseded in
 * R4"), or a coincidence. Deciding is the caller's job — it has the intent, this only has
 * strings. Precision matters more than recall here: a report that fires on every edit gets
 * ignored, and an ignored warning is worse than none.
 */

/** One place the file still mentions something the edit removed. */
export interface Leftover {
    /** The distinctive string that survived. */
    token: string;
    /** 1-based line numbers where it still appears, outside the edited region. */
    lines: number[];
    /** The first such line, trimmed and clipped, for the report. */
    sample: string;
}

/**
 * Tokens common enough that finding them again means nothing. Kept deliberately small:
 * the extractor's own shape rules do most of the filtering, and a long stopword list is
 * how this sort of check silently stops firing on the cases that matter.
 */
const NOISE = new Set([
    'true', 'false', 'null', 'undefined', 'return', 'function', 'const', 'let', 'var',
    'import', 'export', 'default', 'class', 'interface', 'type', 'async', 'await',
    'this', 'self', 'none', 'todo', 'note', 'warning', 'error', 'string', 'number',
    'boolean', 'object', 'array', 'value', 'result', 'data', 'name', 'path', 'file',
]);

/**
 * Pull the strings from `removed` that are specific enough to be worth searching for.
 *
 * The shape rules ARE the precision mechanism, so each earns its place:
 * - snake_case / camelCase / dotted identifiers and filenames: the exact class of thing
 *   that gets referenced from several places in one document, which is what makes a stale
 *   copy possible in the first place.
 * - backtick spans: in prose documents these mark the load-bearing nouns. An author who
 *   wrote `X` in two sections meant the same X both times.
 * - CJK runs of 4+ characters: Chinese prose has no word boundaries, so identifier rules
 *   find nothing. A run that long is a phrase rather than a particle, and phrases are what
 *   get restated. Below 4 it matches everywhere and the report becomes noise.
 *
 * Deliberately NOT extracted: bare English words (a stale sentence rarely shares only
 * common words with its replacement, and matching them floods the report), and numbers
 * alone (`2.14` reappears constantly in a numbered document for legitimate reasons).
 */
export function extractSignificantTokens(removed: string): string[] {
    const out = new Set<string>();

    // Identifier-ish: needs an internal _, ., - or a camelCase hump, so a plain word
    // never qualifies. That single requirement is what keeps prose out.
    for (const m of removed.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:[._-][A-Za-z0-9_]+)+/g)) {
        if (m[0].length >= 6) out.add(m[0]);
    }
    for (const m of removed.matchAll(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g)) {
        if (m[0].length >= 6) out.add(m[0]);
    }

    // Backtick spans — the author's own marking of what matters.
    for (const m of removed.matchAll(/`([^`\n]{3,60})`/g)) {
        const t = m[1].trim();
        if (t) out.add(t);
    }

    // CJK phrases.
    for (const m of removed.matchAll(/[一-鿿]{4,20}/g)) {
        out.add(m[0]);
    }

    return [...out].filter(t => !NOISE.has(t.toLowerCase()));
}

/**
 * Find tokens from the removed text that still appear elsewhere in the new content.
 *
 * `skipStart`/`skipEnd` bound the region the edit just wrote (1-based, inclusive). Hits
 * inside it are ignored: the caller intentionally put that text there, so reporting it back
 * would be pure noise and would train the caller to stop reading these.
 */
export function findLeftovers(
    removed: string,
    newContent: string,
    skipStart: number,
    skipEnd: number,
    opts: { maxTokens?: number; maxLinesPerToken?: number } = {}
): Leftover[] {
    const maxTokens = opts.maxTokens ?? 5;
    const maxLines = opts.maxLinesPerToken ?? 3;

    const tokens = extractSignificantTokens(removed);
    if (tokens.length === 0) return [];

    const lines = newContent.split(/\r\n|\n|\r/);
    const found: Leftover[] = [];

    for (const token of tokens) {
        const hits: number[] = [];
        for (let i = 0; i < lines.length; i++) {
            const lineNo = i + 1;
            if (lineNo >= skipStart && lineNo <= skipEnd) continue;
            if (lines[i].includes(token)) hits.push(lineNo);
        }
        if (hits.length === 0) continue;

        const first = lines[hits[0] - 1].trim();
        found.push({
            token,
            lines: hits.slice(0, maxLines),
            sample: first.length > 90 ? first.slice(0, 90) + '…' : first,
        });
    }

    // Rarest first: a token appearing once elsewhere is far more likely to be the stale
    // copy than one appearing twelve times, which is probably just vocabulary.
    found.sort((a, b) => a.lines.length - b.lines.length);
    return found.slice(0, maxTokens);
}

/** Render leftovers as report lines, or an empty array when there is nothing to say. */
export function formatLeftovers(leftovers: Leftover[]): string[] {
    if (leftovers.length === 0) return [];
    const out = [
        '',
        'Still mentioned elsewhere in this file (may be intentional — e.g. a historical note):',
    ];
    for (const lo of leftovers) {
        const where = lo.lines.map(n => `L${n}`).join(', ');
        out.push(`  "${lo.token}" — ${where}${lo.lines.length >= 3 ? '…' : ''}: ${lo.sample}`);
    }
    return out;
}
