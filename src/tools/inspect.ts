/**
 * File pre-flight inspection.
 *
 * Designed for AI callers to make ONE cheap call before deciding whether to
 * read_file (line-paginate), start_process (jq/python/exiftool/...), or just
 * stop. Without inspect_file, an AI is forced to "read first, regret later" —
 * 50KB of minified JSON gets dragged into context before the format is even
 * known.
 *
 * Reads only the first/last 4 KB of the file plus a single fs.stat. For files
 * smaller than 8 KB the whole file is read once. Always returns a structured
 * JSON object with a single `recommendation` field that the AI can route on
 * directly.
 */

import fs from 'fs/promises';
import path from 'path';
import { isBinaryFile } from 'isbinaryfile';
import { validatePath } from './filesystem.js';
import { getMimeType } from './mime-types.js';
import { configManager } from '../config-manager.js';

const PREVIEW_BYTES = 4096;       // head/tail window for preview + line counting
const PREVIEW_TEXT_CHARS = 200;   // truncated to this for the preview field

export interface InspectFileResult {
    path: string;
    exists: boolean;
    isFile: boolean;
    isDirectory: boolean;
    size: number;
    modified: string | null;
    mimeType: string;
    isBinary: boolean;
    encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'unknown' | 'binary' | 'empty';
    lineCount: number | null;
    longestLineLength: number | null;
    isLikelyMinified: boolean;
    headPreview: string;
    tailPreview: string;
    recommendation: string;
    /** Did we sample only the head/tail of the file (true) or read the whole file (false)? */
    truncatedSample: boolean;
}

function detectEncoding(headBuf: Buffer): InspectFileResult['encoding'] {
    if (headBuf.length === 0) return 'empty';
    // BOMs
    if (headBuf.length >= 3 && headBuf[0] === 0xEF && headBuf[1] === 0xBB && headBuf[2] === 0xBF) return 'utf-8-bom';
    if (headBuf.length >= 2 && headBuf[0] === 0xFF && headBuf[1] === 0xFE) return 'utf-16le';
    if (headBuf.length >= 2 && headBuf[0] === 0xFE && headBuf[1] === 0xFF) return 'utf-16be';
    // Heuristic: even-position null bytes hint at utf-16le without BOM
    let evenZeros = 0;
    const sample = Math.min(headBuf.length, 512);
    for (let i = 1; i < sample; i += 2) {
        if (headBuf[i] === 0) evenZeros++;
    }
    if (sample > 32 && evenZeros / (sample / 2) > 0.7) return 'utf-16le';
    // Default: assume utf-8 (most common; binary detection is separate)
    return 'utf-8';
}

function safeUtf8Slice(buf: Buffer, maxChars: number): string {
    // Buffer.toString may produce a replacement char if cut mid-codepoint.
    // For preview purposes this is acceptable; we just truncate by char count.
    const s = buf.toString('utf8');
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars);
}

function countLinesAndLongestLine(buf: Buffer): { lines: number; longest: number } {
    let lines = 1;
    let longest = 0;
    let cur = 0;
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0A) {
            if (cur > longest) longest = cur;
            lines++;
            cur = 0;
        } else if (buf[i] !== 0x0D) {
            cur++;
        }
    }
    if (cur > longest) longest = cur;
    return { lines, longest };
}

/**
 * Inspect a file — fast, read-only, no parsing of structured formats.
 */
export async function inspectFile(filePath: string): Promise<InspectFileResult> {
    let validPath: string;
    try {
        validPath = await validatePath(filePath);
    } catch (err: any) {
        return {
            path: filePath, exists: false, isFile: false, isDirectory: false,
            size: 0, modified: null, mimeType: 'application/octet-stream',
            isBinary: false, encoding: 'unknown', lineCount: null, longestLineLength: null,
            isLikelyMinified: false, headPreview: '', tailPreview: '',
            recommendation: `Path validation failed: ${err instanceof Error ? err.message : String(err)}`,
            truncatedSample: false,
        };
    }

    const absPath = path.resolve(validPath);

    let stat;
    try {
        stat = await fs.stat(absPath);
    } catch (err: any) {
        const code = err && err.code;
        if (code === 'ENOENT') {
            return {
                path: absPath, exists: false, isFile: false, isDirectory: false,
                size: 0, modified: null, mimeType: getMimeType(absPath),
                isBinary: false, encoding: 'unknown', lineCount: null, longestLineLength: null,
                isLikelyMinified: false, headPreview: '', tailPreview: '',
                recommendation: 'File does not exist',
                truncatedSample: false,
            };
        }
        if (code === 'EACCES' || code === 'EPERM') {
            return {
                path: absPath, exists: true, isFile: false, isDirectory: false,
                size: 0, modified: null, mimeType: getMimeType(absPath),
                isBinary: false, encoding: 'unknown', lineCount: null, longestLineLength: null,
                isLikelyMinified: false, headPreview: '', tailPreview: '',
                recommendation: `Permission denied (${code})`,
                truncatedSample: false,
            };
        }
        throw err;
    }

    const baseResult: Partial<InspectFileResult> = {
        path: absPath, exists: true,
        size: stat.size, modified: stat.mtime.toISOString(),
        mimeType: getMimeType(absPath),
    };

    if (stat.isDirectory()) {
        return {
            ...baseResult, isFile: false, isDirectory: true,
            isBinary: false, encoding: 'unknown', lineCount: null, longestLineLength: null,
            isLikelyMinified: false, headPreview: '', tailPreview: '',
            recommendation: 'Use list_directory(path, depth=1) to see contents',
            truncatedSample: false,
        } as InspectFileResult;
    }

    if (!stat.isFile()) {
        return {
            ...baseResult, isFile: false, isDirectory: false,
            isBinary: false, encoding: 'unknown', lineCount: null, longestLineLength: null,
            isLikelyMinified: false, headPreview: '', tailPreview: '',
            recommendation: 'Special file (symlink/socket/device) — handle with start_process',
            truncatedSample: false,
        } as InspectFileResult;
    }

    // Binary detection (content-based)
    let isBinary = false;
    try {
        isBinary = await isBinaryFile(absPath);
    } catch { /* fall back to false; encoding heuristic still runs */ }

    // Sample head and tail
    const fileSize = stat.size;
    const sampleAll = fileSize <= PREVIEW_BYTES * 2;
    let headBuf: Buffer;
    let tailBuf: Buffer;
    if (sampleAll) {
        headBuf = await fs.readFile(absPath);
        tailBuf = headBuf;
    } else {
        const fh = await fs.open(absPath, 'r');
        try {
            headBuf = Buffer.alloc(PREVIEW_BYTES);
            await fh.read(headBuf, 0, PREVIEW_BYTES, 0);
            tailBuf = Buffer.alloc(PREVIEW_BYTES);
            await fh.read(tailBuf, 0, PREVIEW_BYTES, fileSize - PREVIEW_BYTES);
        } finally {
            await fh.close();
        }
    }

    const encoding = isBinary ? 'binary' : detectEncoding(headBuf);

    let lineCount: number | null = null;
    let longestLineLength: number | null = null;
    if (!isBinary && sampleAll) {
        const counts = countLinesAndLongestLine(headBuf);
        lineCount = counts.lines;
        longestLineLength = counts.longest;
    } else if (!isBinary && !sampleAll) {
        // For large files, line count is an estimate from the head sample only;
        // signal by null longest and use head-derived line count as a *minimum*.
        // We deliberately keep lineCount = null when we can't measure precisely
        // (avoids confusing AI). longestLineLength still uses head sample.
        const headCounts = countLinesAndLongestLine(headBuf);
        // If head buffer contains zero newlines, the file is almost certainly
        // single-line large content (= minified) — we DO surface that as
        // lineCount = 1 (very confident from head only).
        if (headCounts.lines === 1) {
            lineCount = 1;
        }
        longestLineLength = headCounts.longest;
    }

    const isLikelyMinified = !isBinary && lineCount !== null && lineCount <= 2 && fileSize > 10000;

    const headPreview = isBinary
        ? `<binary; first ${headBuf.length} bytes hex: ${headBuf.slice(0, 32).toString('hex')}...>`
        : safeUtf8Slice(headBuf, PREVIEW_TEXT_CHARS);
    const tailPreview = isBinary
        ? `<binary; last bytes hex: ${tailBuf.slice(-32).toString('hex')}>`
        : safeUtf8Slice(tailBuf.slice(-PREVIEW_TEXT_CHARS * 4), PREVIEW_TEXT_CHARS);

    // Recommendation
    let recommendation: string;
    const cfg = await configManager.getConfig();
    const responseMaxChars = cfg.responseMaxChars ?? 50000;
    if (isBinary) {
        recommendation = 'Binary file — use start_process with appropriate tool (Python/Node/jq/exiftool/pdftotext/...). read_file would return an instruction stub.';
    } else if (isLikelyMinified) {
        recommendation = 'Likely minified (single-line large content) — use start_process(jq/python/node) to extract a slice. read_file offset/length is line-based and ineffective here.';
    } else if (fileSize > responseMaxChars) {
        recommendation = `Large file (${fileSize} bytes > ${responseMaxChars} char cap) — use read_file with explicit offset/length to paginate, or start_process(grep/sed/awk) to extract.`;
    } else {
        recommendation = 'Safe to read_file in one call';
    }

    return {
        ...baseResult, isFile: true, isDirectory: false,
        isBinary, encoding, lineCount, longestLineLength, isLikelyMinified,
        headPreview, tailPreview, recommendation,
        truncatedSample: !sampleAll,
    } as InspectFileResult;
}
