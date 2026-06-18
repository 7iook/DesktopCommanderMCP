/**
 * Char-level caps for tool responses. Hosts that don't auto-truncate (Kiro IDE
 * notably) lock up when a single response exceeds their context window. Every
 * tool that returns user / process / file text must funnel through one of these
 * caps so a long-line minified file or a flooding terminal can't kill the chat.
 *
 * The per-session 50MB ring buffer (MAX_BUFFERED_OUTPUT_CHARS) is unaffected;
 * full content remains reachable via paginated reads.
 */

/**
 * Tail-preserving cap for streaming process output.
 * Keeps the most recent chars (state detection / prompt recognition cares
 * about the tail), prepends a truncation marker, snaps to the next newline
 * so the marker isn't mid-line.
 */
export function applyResponseCharCap(text: string, maxChars: number, hint: string): string {
    if (text.length <= maxChars) return text;
    const tail = text.slice(text.length - maxChars);
    // Snap to next newline so the truncation marker isn't mid-line.
    const firstNl = tail.indexOf('\n');
    const cleanTail = firstNl > 0 && firstNl < maxChars * 0.05 ? tail.slice(firstNl + 1) : tail;
    return `[...truncated ${text.length - cleanTail.length} chars; ${hint}]\n${cleanTail}`;
}

/**
 * Head-preserving cap for read_file responses.
 *
 * Critical for single-line minified files (e.g., 5MB single-line JSON):
 * read_file's length=1000 default is line-based and gives ZERO protection
 * when 1 line == whole file. Detects minified shape and gives format-aware
 * guidance — line-based offset/length cannot slice within a single line, so
 * the AI must switch to start_process(jq/python/grep) or raise the cap.
 *
 * Returns:
 *   { text, truncated, originalChars, lineCount, isLikelyMinified }
 * so callers can decide what extra metadata to surface to the host.
 */
export interface ReadFileCapResult {
    text: string;
    truncated: boolean;
    originalChars: number;
    lineCount: number;
    isLikelyMinified: boolean;
}

export function applyReadFileCharCap(text: string, maxChars: number): ReadFileCapResult {
    const originalChars = text.length;
    const lineCount = originalChars === 0 ? 0 : (text.match(/\n/g) || []).length + 1;
    if (originalChars <= maxChars) {
        return { text, truncated: false, originalChars, lineCount, isLikelyMinified: false };
    }
    const isLikelyMinified = lineCount <= 2 && originalChars > 10000;
    const head = text.slice(0, maxChars);
    const truncatedChars = originalChars - maxChars;
    let hint: string;
    if (isLikelyMinified) {
        hint =
            `⚠️ File is ${originalChars} chars on ${lineCount} line(s) — likely minified (JSON/JS/CSS). ` +
            `read_file offset/length are line-based and CANNOT slice within a single line. ` +
            `Options: ` +
            `(1) start_process with jq/python/node to extract a slice ` +
            `(e.g. node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('FILE','utf8')).somePath))"); ` +
            `(2) raise the cap: set_config_value("responseMaxChars", <larger>); ` +
            `(3) get_file_info first to gauge size before reading.`;
    } else {
        const linesShown = (head.match(/\n/g) || []).length;
        hint =
            `⚠️ File is ${originalChars} chars (${lineCount} lines); showing first ${head.length} chars (~${linesShown} lines). ` +
            `Read more: read_file with offset=${linesShown}; ` +
            `or raise the cap: set_config_value("responseMaxChars", <larger>).`;
    }
    return {
        text: `${head}\n\n[...truncated ${truncatedChars} chars]\n${hint}`,
        truncated: true,
        originalChars,
        lineCount,
        isLikelyMinified,
    };
}
