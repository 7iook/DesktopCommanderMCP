/**
 * Text file handler
 * Handles reading, writing, and editing text files
 *
 * Binary detection is handled at the factory level (factory.ts) using isBinaryFile.
 * This handler only receives files that have been confirmed as text.
 *
 * TECHNICAL DEBT:
 * This handler is missing editRange() - text search/replace logic currently lives in
 * src/tools/edit.ts (performSearchReplace function) instead of here.
 *
 * For architectural consistency with ExcelFileHandler.editRange(), the fuzzy
 * search/replace logic should be moved here. See comment in src/tools/edit.ts.
 */

import fs from "fs/promises";
import path from "path";
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import {
    FileHandler,
    ReadOptions,
    FileResult,
    FileInfo,
    EditResult
} from './base.js';
import { detectLineEnding, normalizeLineEndings } from '../lineEndingHandler.js';
import {
    splitLines,
    findHeadings,
    matchHeadings,
    resolveSection,
    hashSectionBody,
    normalizeHeading
} from './markdownSection.js';

// TODO: Centralize these constants with filesystem.ts to avoid silent drift
// These duplicate concepts from filesystem.ts and should be moved to a shared
// constants module (e.g., src/utils/files/constants.ts) during reorganization
const FILE_SIZE_LIMITS = {
    LARGE_FILE_THRESHOLD: 10 * 1024 * 1024,  // 10MB
    LINE_COUNT_LIMIT: 10 * 1024 * 1024,      // 10MB for line counting
} as const;

/**
 * Run a readline pass over a file and guarantee the underlying descriptor is
 * released, even when the consumer breaks out of the loop early.
 *
 * `rl.close()` only tears down the readline interface — it does NOT close the
 * input stream. A stream that reached EOF closes itself, which is why full
 * reads never leaked; but every early `break` (line-limit reached, sample size
 * reached) left the fd open until GC. On Windows that fd keeps the file locked,
 * so later deletes and atomic `rename` replacements fail with EPERM/EBUSY.
 *
 * Upstream issues: #476 (locked large files), #502 (locked `.tmp*` files).
 */
async function withLineReader<T>(
    filePath: string,
    streamOptions: { start?: number; signal?: AbortSignal },
    consume: (lines: AsyncIterable<string>) => Promise<T>
): Promise<T> {
    const stream = createReadStream(filePath, streamOptions);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
        return await consume(rl);
    } finally {
        rl.close();
        stream.destroy();
    }
}

const READ_PERFORMANCE_THRESHOLDS = {
    SMALL_READ_THRESHOLD: 100,    // For very small reads
    DEEP_OFFSET_THRESHOLD: 1000,  // For byte estimation
    SAMPLE_SIZE: 10000,           // Sample size for estimation
    CHUNK_SIZE: 8192,             // 8KB chunks for reverse reading
} as const;

/**
 * Text file handler implementation
 * Binary detection is done at the factory level - this handler assumes file is text
 */
export class TextFileHandler implements FileHandler {
    /**
     * This handler does NOT own old_string/new_string replacement — see the dispatcher in
     * src/tools/edit.ts. Its editRange() serves markdown section addressing only.
     *
     * Why this flag exists: the dispatcher used to route text replacement to editRange()
     * whenever a handler merely HAD that method. Adding editRange() here would therefore
     * have silently rerouted every existing text edit away from performSearchReplace(),
     * bypassing fuzzy matching, mixed-EOL diagnostics and the A-004 path-grouping fix.
     * DOCX genuinely owns its text replacement (find/replace over pretty-printed XML) and
     * sets this true; text does not.
     */
    readonly ownsTextReplacement = false;

    /**
     * A markdown section body is prose, not a JSON payload — the dispatcher must not
     * JSON.parse() it (a section whose entire body is `123` has to stay literal text).
     */
    readonly rangeContentIsRawText = true;

    canHandle(_path: string): boolean {
        // Text handler accepts all files that pass the factory's binary check
        // The factory routes binary files to BinaryFileHandler before reaching here
        return true;
    }

    async read(filePath: string, options?: ReadOptions): Promise<FileResult> {
        const offset = options?.offset ?? 0;
        const length = options?.length ?? 1000; // Default from config
        const includeStatusMessage = options?.includeStatusMessage ?? true;

        // Binary detection is done at factory level - just read as text
        return this.readFileWithSmartPositioning(filePath, offset, length, 'text/plain', includeStatusMessage, options?.signal);
    }

    async write(path: string, content: string, mode: 'rewrite' | 'append' = 'rewrite'): Promise<void> {
        if (mode === 'append') {
            await fs.appendFile(path, content);
        } else {
            await fs.writeFile(path, content);
        }
    }

    async getInfo(path: string): Promise<FileInfo> {
        const stats = await fs.stat(path);

        const info: FileInfo = {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            permissions: stats.mode.toString(8).slice(-3),
            fileType: 'text',
            metadata: {}
        };

        // For text files that aren't too large, count lines
        if (stats.isFile() && stats.size < FILE_SIZE_LIMITS.LINE_COUNT_LIMIT) {
            try {
                const content = await fs.readFile(path, 'utf8');
                const lineCount = TextFileHandler.countLines(content);
                info.metadata!.lineCount = lineCount;
            } catch (error) {
                // If reading fails, skip line count
            }
        }

        return info;
    }

    // ========================================================================
    // Private Helper Methods (extracted from filesystem.ts)
    // ========================================================================

    /**
     * Count lines in text content
     * Made static and public for use by other modules (e.g., writeFile telemetry in filesystem.ts)
     */
    static countLines(content: string): number {
        if (content === '') return 0;
        // A file with N lines has N-1 newline characters.
        // If the file ends with a trailing newline, don't count the empty string after it.
        const lines = content.split('\n');
        if (lines[lines.length - 1] === '') {
            return lines.length - 1;
        }
        return lines.length;
    }

    /**
     * Get file line count (for files under size limit)
     */
    private async getFileLineCount(filePath: string, signal?: AbortSignal): Promise<number | undefined> {
        try {
            const stats = await fs.stat(filePath);
            if (stats.size < FILE_SIZE_LIMITS.LINE_COUNT_LIMIT) {
                const content = await fs.readFile(filePath, { encoding: 'utf8', signal });
                return TextFileHandler.countLines(content);
            }
        } catch (error) {
            // If we can't read the file, return undefined
        }
        return undefined;
    }

    /**
     * Generate enhanced status message
     */
    private generateEnhancedStatusMessage(
        readLines: number,
        offset: number,
        totalLines?: number,
        isNegativeOffset: boolean = false
    ): string {
        if (isNegativeOffset) {
            if (totalLines !== undefined) {
                return `[Reading last ${readLines} lines (total: ${totalLines} lines)]`;
            } else {
                return `[Reading last ${readLines} lines]`;
            }
        } else {
            if (totalLines !== undefined) {
                const endLine = offset + readLines;
                const remainingLines = Math.max(0, totalLines - endLine);

                if (offset === 0) {
                    return `[Reading ${readLines} lines from start (total: ${totalLines} lines, ${remainingLines} remaining)]`;
                } else {
                    return `[Reading ${readLines} lines from line ${offset} (total: ${totalLines} lines, ${remainingLines} remaining)]`;
                }
            } else {
                if (offset === 0) {
                    return `[Reading ${readLines} lines from start]`;
                } else {
                    return `[Reading ${readLines} lines from line ${offset}]`;
                }
            }
        }
    }

    /**
     * Split text into lines while preserving line endings
     * Made static and public for use by other modules (e.g., readFileInternal in filesystem.ts)
     */
    static splitLinesPreservingEndings(content: string): string[] {
        if (!content) return [''];

        const lines: string[] = [];
        let currentLine = '';

        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            currentLine += char;

            if (char === '\n') {
                lines.push(currentLine);
                currentLine = '';
            } else if (char === '\r') {
                if (i + 1 < content.length && content[i + 1] === '\n') {
                    currentLine += content[i + 1];
                    i++;
                }
                lines.push(currentLine);
                currentLine = '';
            }
        }

        if (currentLine) {
            lines.push(currentLine);
        }

        return lines;
    }

    /**
     * Read file with smart positioning for optimal performance
     */
    private async readFileWithSmartPositioning(
        filePath: string,
        offset: number,
        length: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        signal?: AbortSignal
    ): Promise<FileResult> {
        const stats = await fs.stat(filePath);
        const fileSize = stats.size;

        const totalLines = await this.getFileLineCount(filePath, signal);

        // For negative offsets (tail behavior), use reverse reading
        if (offset < 0) {
            const requestedLines = Math.abs(offset);

            if (fileSize > FILE_SIZE_LIMITS.LARGE_FILE_THRESHOLD &&
                requestedLines <= READ_PERFORMANCE_THRESHOLDS.SMALL_READ_THRESHOLD) {
                return await this.readLastNLinesReverse(filePath, requestedLines, mimeType, includeStatusMessage, totalLines, signal);
            } else {
                return await this.readFromEndWithReadline(filePath, requestedLines, mimeType, includeStatusMessage, totalLines, signal);
            }
        }
        // For positive offsets
        else {
            if (fileSize < FILE_SIZE_LIMITS.LARGE_FILE_THRESHOLD || offset === 0) {
                return await this.readFromStartWithReadline(filePath, offset, length, mimeType, includeStatusMessage, totalLines, signal);
            } else {
                if (offset > READ_PERFORMANCE_THRESHOLDS.DEEP_OFFSET_THRESHOLD) {
                    return await this.readFromEstimatedPosition(filePath, offset, length, mimeType, includeStatusMessage, totalLines, signal);
                } else {
                    return await this.readFromStartWithReadline(filePath, offset, length, mimeType, includeStatusMessage, totalLines, signal);
                }
            }
        }
    }

    /**
     * Read last N lines efficiently by reading file backwards
     */
    private async readLastNLinesReverse(
        filePath: string,
        n: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number,
        signal?: AbortSignal
    ): Promise<FileResult> {
        const fd = await fs.open(filePath, 'r');
        try {
            const stats = await fd.stat();
            const fileSize = stats.size;

            let position = fileSize;
            let lines: string[] = [];
            let partialLine = '';

            while (position > 0 && lines.length < n) {
                if (signal?.aborted) {
                    const err = new Error('Read aborted') as NodeJS.ErrnoException;
                    err.code = 'ABORT_ERR';
                    throw err;
                }
                const readSize = Math.min(READ_PERFORMANCE_THRESHOLDS.CHUNK_SIZE, position);
                position -= readSize;

                const buffer = Buffer.alloc(readSize);
                await fd.read(buffer, 0, readSize, position);

                const chunk = buffer.toString('utf-8');
                const text = chunk + partialLine;
                const chunkLines = text.split('\n');

                partialLine = chunkLines.shift() || '';
                lines = chunkLines.concat(lines);
            }

            if (position === 0 && partialLine) {
                lines.unshift(partialLine);
            }

            const result = lines.slice(-n);
            const content = includeStatusMessage
                ? `${this.generateEnhancedStatusMessage(result.length, -n, fileTotalLines, true)}\n\n${result.join('\n')}`
                : result.join('\n');

            return { content, mimeType, metadata: {} };
        } finally {
            await fd.close();
        }
    }

    /**
     * Read from end using readline with circular buffer
     */
    private async readFromEndWithReadline(
        filePath: string,
        requestedLines: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number,
        signal?: AbortSignal
    ): Promise<FileResult> {
        const buffer: string[] = new Array(requestedLines);
        let bufferIndex = 0;
        let totalLines = 0;

        await withLineReader(filePath, { signal }, async (lines) => {
            for await (const line of lines) {
                buffer[bufferIndex] = line;
                bufferIndex = (bufferIndex + 1) % requestedLines;
                totalLines++;
            }
        });

        let result: string[];
        if (totalLines >= requestedLines) {
            result = [
                ...buffer.slice(bufferIndex),
                ...buffer.slice(0, bufferIndex)
            ].filter(line => line !== undefined);
        } else {
            result = buffer.slice(0, totalLines);
        }

        const content = includeStatusMessage
            ? `${this.generateEnhancedStatusMessage(result.length, -requestedLines, fileTotalLines, true)}\n\n${result.join('\n')}`
            : result.join('\n');

        return { content, mimeType, metadata: {} };
    }

    /**
     * Read from start/middle using readline
     */
    private async readFromStartWithReadline(
        filePath: string,
        offset: number,
        length: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number,
        signal?: AbortSignal
    ): Promise<FileResult> {
        const result: string[] = [];
        let lineNumber = 0;

        await withLineReader(filePath, { signal }, async (lines) => {
            for await (const line of lines) {
                if (lineNumber >= offset && result.length < length) {
                    result.push(line);
                }
                if (result.length >= length) break;
                lineNumber++;
            }
        });

        if (includeStatusMessage) {
            const statusMessage = this.generateEnhancedStatusMessage(result.length, offset, fileTotalLines, false);
            const content = `${statusMessage}\n\n${result.join('\n')}`;
            return { content, mimeType, metadata: {} };
        } else {
            const content = result.join('\n');
            return { content, mimeType, metadata: {} };
        }
    }

    /**
     * Read from estimated byte position for very large files
     */
    private async readFromEstimatedPosition(
        filePath: string,
        offset: number,
        length: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number,
        signal?: AbortSignal
    ): Promise<FileResult> {
        // First, do a quick scan to estimate lines per byte
        let sampleLines = 0;
        let bytesRead = 0;

        await withLineReader(filePath, { signal }, async (lines) => {
            for await (const line of lines) {
                bytesRead += Buffer.byteLength(line, 'utf-8') + 1;
                sampleLines++;
                if (bytesRead >= READ_PERFORMANCE_THRESHOLDS.SAMPLE_SIZE) break;
            }
        });

        if (sampleLines === 0) {
            return await this.readFromStartWithReadline(filePath, offset, length, mimeType, includeStatusMessage, fileTotalLines, signal);
        }

        // Estimate position
        const avgLineLength = bytesRead / sampleLines;
        const estimatedBytePosition = Math.floor(offset * avgLineLength);

        const fd = await fs.open(filePath, 'r');
        try {
            const stats = await fd.stat();
            const startPosition = Math.min(estimatedBytePosition, stats.size);

            const result: string[] = [];
            let firstLineSkipped = false;

            await withLineReader(filePath, { start: startPosition, signal }, async (lines) => {
                for await (const line of lines) {
                    if (!firstLineSkipped && startPosition > 0) {
                        firstLineSkipped = true;
                        continue;
                    }

                    if (result.length < length) {
                        result.push(line);
                    } else {
                        break;
                    }
                }
            });

            const content = includeStatusMessage
                ? `${this.generateEnhancedStatusMessage(result.length, offset, fileTotalLines, false)}\n\n${result.join('\n')}`
                : result.join('\n');

            return { content, mimeType, metadata: {} };
        } finally {
            await fd.close();
        }
    }

    /**
     * Replace a markdown section's body, addressed by its heading line.
     *
     * WHY THIS IS SEPARATE FROM edit_block's TEXT PATH
     * `old_string` replacement needs the caller to hold a byte-exact copy of the old text.
     * For a whole-section rewrite that means quoting the entire section, where one full-width
     * comma or trailing space fails the edit. Here only the heading line is matched and the
     * end boundary is computed from the heading hierarchy, so the caller never quotes the
     * body it is replacing.
     *
     * ⚠️ DELIBERATELY NOT WIRED INTO edit_block's old_string PATH.
     * `edit.ts` dispatches text replacement to `performSearchReplace`, which owns fuzzy
     * matching, mixed-EOL diagnostics and the A-004 path-grouping fix. This method must never
     * become the route for `old_string` edits — `ownsTextReplacement` on this class stays
     * false so the dispatcher keeps sending them to `performSearchReplace`.
     *
     * @param path      Validated absolute path
     * @param range     Heading text (leading `#` optional); `''` is rejected
     * @param content   New body WITHOUT the heading line
     * @param options   `{ expected_section_hash }` — REQUIRED (see below)
     */
    async editRange(
        path: string,
        range: string,
        content: any,
        options?: Record<string, any>
    ): Promise<EditResult> {
        const fail = (error: string): EditResult => ({
            success: false,
            editsApplied: 0,
            errors: [{ location: range || '(empty range)', error }],
        });

        if (typeof range !== 'string' || range.trim() === '') {
            return fail('section mode requires a non-empty heading in `range`');
        }
        if (typeof content !== 'string') {
            return fail('section mode requires `content` to be a string (the new section body)');
        }

        // The concurrency token is MANDATORY, not advisory. Section mode removes the implicit
        // compare-before-write that `old_string` provided for free; making the hash optional
        // would turn "stale writes fail loudly" into "stale writes clobber silently" — the
        // exact regression review DC1 flagged. Callers must read the section first.
        const expected = options?.expected_section_hash;
        if (typeof expected !== 'string' || expected === '') {
            return fail(
                'missing_section_hash: section mode requires `expected_section_hash` ' +
                '(sha256 of the current section body). Read the section first, then retry.'
            );
        }

        const original = await fs.readFile(path, 'utf8');
        const lineEnding = detectLineEnding(original);
        const lines = splitLines(original);
        const headings = findHeadings(lines);
        const hits = matchHeadings(headings, range);

        // A hallucinated or ambiguous heading must never fall through to a guess: replacing the
        // wrong section destroys a whole block, so both misses fail loudly instead.
        if (hits.length === 0) {
            const suggestions = headings
                .map(h => ({ h, score: similarityScore(normalizeHeading(range), h.normalized) }))
                // 0.3, not 0.5: these are hints, not decisions — the edit already failed and
                // nothing is applied automatically, so a slightly noisy list costs the caller
                // one glance while a missing list costs another wrong round-trip.
                .filter(s => s.score >= 0.3)
                .sort((a, b) => b.score - a.score)
                .slice(0, 3)
                .map(s => `  line ${s.h.lineIndex + 1}: ${s.h.raw.trim()} (${Math.round(s.score * 100)}%)`);

            return fail(
                `heading not found: "${range}"` +
                (suggestions.length ? `\nclosest headings:\n${suggestions.join('\n')}` : '') +
                '\nNote: suggestions are NOT applied automatically — re-issue with an exact heading.'
            );
        }
        if (hits.length > 1) {
            const where = hits.map(i => `line ${headings[i].lineIndex + 1}`).join(', ');
            return fail(
                `heading is not unique: "${range}" matches ${hits.length} headings (${where}). ` +
                'Section mode cannot narrow by parent path; use old_string/new_string for this edit.'
            );
        }

        const section = resolveSection(lines, headings, hits[0]);
        const actual = hashSectionBody(lines, section);
        if (actual !== expected) {
            return fail(
                `stale_section: the section body changed since it was read. ` +
                `expected ${expected}, actual ${actual}. Re-read the section and retry.`
            );
        }

        // Splice the body, keeping the heading line and everything outside the section
        // byte-identical. Content is normalized to the file's existing line ending so a
        // CRLF file does not silently gain LF lines.
        const newBody = content === '' ? [] : splitLines(normalizeLineEndings(content, lineEnding));
        const updated = [
            ...lines.slice(0, section.bodyStart),
            ...newBody,
            ...lines.slice(section.bodyEnd),
        ].join(lineEnding);

        await fs.writeFile(path, updated, 'utf8');
        return { success: true, editsApplied: 1 };
    }
}

/**
 * Cheap similarity for heading suggestions only (never for deciding a match).
 *
 * Deliberately not the worker-thread fuzzy search from tools/fuzzySearch.ts: that one is
 * built for scanning whole-file content for a multi-line needle, whereas this compares two
 * short single-line strings where a character-bigram ratio is adequate and synchronous.
 *
 * Containment scores 0.9 regardless of length ratio. A pure bigram ratio punishes short
 * headings hard — measured in an end-to-end run, "Beta Section" vs "Beta" scored below the
 * suggestion cut-off, so a caller who wrote a slightly-too-long heading got no hint at all
 * and had to guess again. One substring being the other is exactly the typo class worth
 * surfacing (extra or dropped trailing words), so it is scored on containment rather than
 * on how much text the two share.
 */
function similarityScore(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    if (a.includes(b) || b.includes(a)) return 0.9;

    const bigrams = new Map<string, number>();
    for (let i = 0; i < a.length - 1; i++) {
        const g = a.slice(i, i + 2);
        bigrams.set(g, (bigrams.get(g) ?? 0) + 1);
    }

    let hits = 0;
    for (let i = 0; i < b.length - 1; i++) {
        const g = b.slice(i, i + 2);
        const n = bigrams.get(g) ?? 0;
        if (n > 0) {
            bigrams.set(g, n - 1);
            hits++;
        }
    }

    return (2 * hits) / (a.length - 1 + b.length - 1);
}
