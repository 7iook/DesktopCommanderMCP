/**
 * Text file editing via search/replace with fuzzy matching support.
 *
 * TECHNICAL DEBT / ARCHITECTURAL NOTE:
 * This file contains text editing logic that should ideally live in TextFileHandler.editRange()
 * to be consistent with how Excel editing works (ExcelFileHandler.editRange()).
 *
 * Current inconsistency:
 * - Excel: edit_block → ExcelFileHandler.editRange() ✓ uses file handler
 * - Text:  edit_block → performSearchReplace() here → bypasses TextFileHandler
 *
 * Future refactor should:
 * 1. Move performSearchReplace() + fuzzy logic into TextFileHandler.editRange()
 * 2. Make this file a thin dispatch layer that routes to appropriate FileHandler
 * 3. Unify the editRange() signature to handle both text search/replace and structured edits
 */

import { getDefaultEditorMetadata, readFile, writeFile, readFileInternal, validatePath } from './filesystem.js';
import fs from 'fs/promises';
import { ServerResult } from '../types.js';
import { runFuzzySearchInWorker, getSimilarityRatio } from './fuzzySearch.js';
import { capture } from '../utils/capture.js';
import { withFileLock } from '../utils/file-mutex.js';
import { getFileHandler } from '../utils/files/index.js';
import { createErrorResponse } from '../error-handlers.js';
import { EditBlockArgsSchema, EditBlockMultipleArgsSchema } from "./schemas.js";
import path from 'path';
import { detectLineEnding, normalizeLineEndings, type LineEndingStyle } from '../utils/lineEndingHandler.js';
import { configManager } from '../config-manager.js';
import { fuzzySearchLogger, type FuzzySearchLogEntry } from '../utils/fuzzySearchLogger.js';
import { resolvePreviewFileType } from '../ui/file-preview/shared/preview-file-types.js';
import { resolveAbsolutePath } from '../handlers/filesystem-handlers.js';

interface SearchReplace {
    search: string;
    replace: string;
}

interface FuzzyMatch {
    start: number;
    end: number;
    value: string;
    distance: number;
    similarity: number;
}

/**
 * Threshold for fuzzy matching - similarity must be at least this value to be considered
 * (0-1 scale where 1 is perfect match and 0 is completely different)
 */
const FUZZY_THRESHOLD = 0.7;

/**
 * Extract character code data from diff
 * @param expected The string that was searched for
 * @param actual The string that was found
 * @returns Character code statistics
 */
function getCharacterCodeData(expected: string, actual: string): {
    report: string;
    uniqueCount: number;
    diffLength: number;
} {
    // Find common prefix and suffix
    let prefixLength = 0;
    const minLength = Math.min(expected.length, actual.length);

    // Determine common prefix length
    while (prefixLength < minLength &&
           expected[prefixLength] === actual[prefixLength]) {
        prefixLength++;
    }

    // Determine common suffix length
    let suffixLength = 0;
    while (suffixLength < minLength - prefixLength &&
           expected[expected.length - 1 - suffixLength] === actual[actual.length - 1 - suffixLength]) {
        suffixLength++;
    }
    
    // Extract the different parts
    const expectedDiff = expected.substring(prefixLength, expected.length - suffixLength);
    const actualDiff = actual.substring(prefixLength, actual.length - suffixLength);
    
    // Count unique character codes in the diff
    const characterCodes = new Map<number, number>();
    const fullDiff = expectedDiff + actualDiff;
    
    for (let i = 0; i < fullDiff.length; i++) {
        const charCode = fullDiff.charCodeAt(i);
        characterCodes.set(charCode, (characterCodes.get(charCode) || 0) + 1);
    }
    
    // Create character codes string report
    const charCodeReport: string[] = [];
    characterCodes.forEach((count, code) => {
        // Include character representation for better readability
        const char = String.fromCharCode(code);
        // Make special characters more readable
        const charDisplay = code < 32 || code > 126 ? `\\x${code.toString(16).padStart(2, '0')}` : char;
        charCodeReport.push(`${code}:${count}[${charDisplay}]`);
    });
    
    // Sort by character code for consistency
    charCodeReport.sort((a, b) => {
        const codeA = parseInt(a.split(':')[0]);
        const codeB = parseInt(b.split(':')[0]);
        return codeA - codeB;
    });
    
    return {
        report: charCodeReport.join(','),
        uniqueCount: characterCodes.size,
        diffLength: fullDiff.length
    };
}

/**
 * Result of an in-memory exact search/replace (no I/O).
 */
export interface ExactReplaceResult {
    count: number;          // exact occurrences found in `content`
    applied: boolean;       // true iff count>0 && count===expectedReplacements
    newContent: string;     // mutated content when applied, else === input content
}

/**
 * Pure exact-match search/replace on an in-memory string. Shared by
 * performSearchReplace (single edit) and editBlockMultiple (batch) so the
 * matching/replacement semantics live in ONE place (SSOT — see this file's
 * header tech-debt note). No fuzzy fallback, no I/O, no telemetry — callers
 * own those. `lineEnding` is the file's detected EOL so the search/replace
 * strings are normalized to match.
 */
export function exactReplaceInContent(
    content: string,
    search: string,
    replace: string,
    expectedReplacements: number,
    lineEnding: LineEndingStyle
): ExactReplaceResult {
    const normalizedSearch = normalizeLineEndings(search, lineEnding);
    if (normalizedSearch === '') {
        return { count: 0, applied: false, newContent: content };
    }

    let count = 0;
    let pos = content.indexOf(normalizedSearch);
    while (pos !== -1) {
        count++;
        pos = content.indexOf(normalizedSearch, pos + 1);
    }

    if (count > 0 && count === expectedReplacements) {
        const normalizedReplace = normalizeLineEndings(replace, lineEnding);
        let newContent: string;
        if (expectedReplacements === 1) {
            const i = content.indexOf(normalizedSearch);
            newContent = content.slice(0, i) + normalizedReplace + content.slice(i + normalizedSearch.length);
        } else {
            newContent = content.split(normalizedSearch).join(normalizedReplace);
        }
        return { count, applied: true, newContent };
    }

    return { count, applied: false, newContent: content };
}

export async function performSearchReplace(filePath: string, block: SearchReplace, expectedReplacements: number = 1): Promise<ServerResult> {
    const fileExtension = path.extname(filePath).toLowerCase();
    
    // Capture file extension and string sizes in telemetry without capturing the file path
    capture('server_edit_block', {
        fileExtension: fileExtension,
        oldStringLength: block.search.length,
        oldStringLines: block.search.split('\n').length,
        newStringLength: block.replace.length,
        newStringLines: block.replace.split('\n').length,
        expectedReplacements: expectedReplacements
    });
    // Check for empty search string to prevent infinite loops
    if (block.search === "") {
    
        // Capture file extension in telemetry without capturing the file path
        capture('server_edit_block_empty_search', {fileExtension: fileExtension, expectedReplacements});
        return {
            content: [{ 
                type: "text", 
                text: "Empty search strings are not allowed. Please provide a non-empty string to search for."
            }],
        };
    }
    

    // Read file directly to preserve line endings - critical for edit operations
    const validPath = await validatePath(filePath);

    // Serialize against concurrent edits/writes on the same file. Without
    // this, N concurrent edit_block calls each read V1, each compute a
    // different V2, last writer wins → N-1 lost updates. (.race-repro.mjs
    // demonstrates 4-of-5 lost on the unlocked path.) Same per-path queue
    // used by writeFile so cross-tool concurrency is also serialized.
    return withFileLock(validPath, async () => {
        const content = await readFileInternal(validPath, 0, Number.MAX_SAFE_INTEGER);
    
    // Make sure content is a string
    if (typeof content !== 'string') {
        capture('server_edit_block_content_not_string', {fileExtension: fileExtension, expectedReplacements});
        throw new Error('Wrong content for file ' + filePath);
    }
    
    // Get the line limit from configuration
    const config = await configManager.getConfig();
    const MAX_LINES = config.fileWriteLineLimit ?? 50; // Default to 50 if not set
    
    // Detect file's line ending style
    const fileLineEnding = detectLineEnding(content);
    
    // Normalize search string to match file's line endings
    const normalizedSearch = normalizeLineEndings(block.search, fileLineEnding);
    
    // First try exact match via the shared pure core (SSOT with editBlockMultiple).
    const exact = exactReplaceInContent(content, block.search, block.replace, expectedReplacements, fileLineEnding);
    const count = exact.count;

    // If exact match found and count matches expected replacements, proceed with exact replacement
    if (exact.applied) {
        const newContent = exact.newContent;

        // Check if search or replace text has too many lines
        const searchLines = block.search.split('\n').length;
        const replaceLines = block.replace.split('\n').length;
        const maxLines = Math.max(searchLines, replaceLines);
        let warningMessage = "";
        
        if (maxLines > MAX_LINES) {
            const problemText = searchLines > replaceLines ? 'search text' : 'replacement text';
            warningMessage = `\n\nWARNING: The ${problemText} has ${maxLines} lines (maximum: ${MAX_LINES}).
            
RECOMMENDATION: For large search/replace operations, consider breaking them into smaller chunks with fewer lines.`;
        }
        
        // Direct handler.write here (not the higher-level writeFile) because
        // we already hold the per-path lock — calling writeFile() would try
        // to re-acquire the same lock and deadlock. The file already exists
        // (we just read it), so no parent-mkdir is needed either.
        const handler = await getFileHandler(validPath);
        await handler.write(validPath, newContent, 'rewrite');
        capture('server_edit_block_exact_success', {fileExtension: fileExtension, expectedReplacements, hasWarning: warningMessage !== ""});

        const resolvedEditPath = resolveAbsolutePath(filePath);

        // Show a partial preview centered on the edited area
        const newLines = newContent.split('\n');
        const totalLines = newLines.length;
        const changePos = content.indexOf(normalizedSearch);
        const changeStartLine = changePos >= 0 ? newContent.substring(0, changePos).split('\n').length - 1 : 0;
        const changeLineCount = block.replace.split('\n').length;
        const contextLines = 10;
        const previewStart = Math.max(0, changeStartLine - contextLines);
        const previewEnd = Math.min(totalLines, changeStartLine + changeLineCount + contextLines);
        const previewContent = newLines.slice(previewStart, previewEnd).join('\n');
        const previewLineCount = previewEnd - previewStart;
        const remaining = totalLines - previewEnd;
        const statusLine = `[Reading ${previewLineCount} lines from ${previewStart === 0 ? 'start' : `line ${previewStart}`} (total: ${totalLines} lines, ${remaining} remaining)]\n\n`;

        return {
            content: [{
                type: "text",
                text: `${statusLine}${previewContent}`
            }],
            structuredContent: {
                fileName: path.basename(resolvedEditPath),
                filePath: resolvedEditPath,
                fileType: resolvePreviewFileType(resolvedEditPath),
                sourceTool: 'edit_block',
                ...await getDefaultEditorMetadata(resolvedEditPath),
            },
        };
    }
    
    // If exact match found but count doesn't match expected, inform the user
    if (count > 0 && count !== expectedReplacements) {
        capture('server_edit_block_unexpected_count', {fileExtension: fileExtension, expectedReplacements, expectedReplacementsCount: count});
        return {
            content: [{ 
                type: "text", 
                text: `Expected ${expectedReplacements} occurrences but found ${count} in ${filePath}. ` + 
            `Double check and make sure you understand all occurencies and if you want to replace all ${count} occurrences, set expected_replacements to ${count}. ` +
            `If there are many occurrancies and you want to change some of them and keep the rest. Do it one by one, by adding more lines around each occurrence.` +
`If you want to replace a specific occurrence, make your search string more unique by adding more lines around search string.`
            }],
        };
    }
    
    // If exact match not found, try fuzzy search
    if (count === 0) {
        // Track fuzzy search time
        const startTime = performance.now();

        // Perform fuzzy search in a worker thread so the main event loop stays
        // responsive to pings and parallel tool calls during the scan
        const fuzzyResult = await runFuzzySearchInWorker(content, block.search);
        const similarity = getSimilarityRatio(block.search, fuzzyResult.value);
        
        // Calculate execution time in milliseconds
        const executionTime = performance.now() - startTime;
        
        // Generate diff and gather character code data
        const diff = highlightDifferences(block.search, fuzzyResult.value);
        
        // Count character codes in diff
        const characterCodeData = getCharacterCodeData(block.search, fuzzyResult.value);
        
        // Create comprehensive log entry
        const logEntry: FuzzySearchLogEntry = {
            timestamp: new Date(),
            searchText: block.search,
            foundText: fuzzyResult.value,
            similarity: similarity,
            executionTime: executionTime,
            exactMatchCount: count,
            expectedReplacements: expectedReplacements,
            fuzzyThreshold: FUZZY_THRESHOLD,
            belowThreshold: similarity < FUZZY_THRESHOLD,
            diff: diff,
            searchLength: block.search.length,
            foundLength: fuzzyResult.value.length,
            fileExtension: fileExtension,
            characterCodes: characterCodeData.report,
            uniqueCharacterCount: characterCodeData.uniqueCount,
            diffLength: characterCodeData.diffLength
        };
        
        // Log to file
        await fuzzySearchLogger.log(logEntry);
        
        // Combine all fuzzy search data for single capture
        const fuzzySearchData = {
            similarity: similarity,
            execution_time_ms: executionTime,
            search_length: block.search.length,
            file_size: content.length,
            threshold: FUZZY_THRESHOLD,
            found_text_length: fuzzyResult.value.length,
            character_codes: characterCodeData.report,
            unique_character_count: characterCodeData.uniqueCount,
            total_diff_length: characterCodeData.diffLength
        };
        
        // Check if the fuzzy match is "close enough"
        if (similarity >= FUZZY_THRESHOLD) {
            // Capture the fuzzy search event with all data
            capture('server_fuzzy_search_performed', fuzzySearchData);

            // If we allow fuzzy matches, we would make the replacement here
            // For now, we'll return a detailed message about the fuzzy match
            const groundTruth = extractContextAround(content, fuzzyResult.value);
            return {
                content: [{
                    type: "text",
                    text: `Exact match not found, but found a similar text with ${Math.round(similarity * 100)}% similarity (found in ${executionTime.toFixed(2)}ms):\n\n` +
                          `Differences:\n${diff}\n\n` +
                          `Actual file content (copy this verbatim as your next old_string):\n${groundTruth}\n\n` +
                          `Log entry saved for analysis. Use the following command to check the log:\n` +
                          `Check log: ${await fuzzySearchLogger.getLogPath()}`
                }],// TODO
            };
        } else {
            // If the fuzzy match isn't close enough
            // Still capture the fuzzy search event with all data
            capture('server_fuzzy_search_performed', {
                ...fuzzySearchData,
                below_threshold: true
            });

            const groundTruth = extractContextAround(content, fuzzyResult.value);
            return {
                content: [{
                    type: "text",
                    text: `Search content not found in ${filePath}. The closest match was "${fuzzyResult.value.slice(0, 200)}${fuzzyResult.value.length > 200 ? '...' : ''}" ` +
                          `with only ${Math.round(similarity * 100)}% similarity, which is below the ${Math.round(FUZZY_THRESHOLD * 100)}% threshold. ` +
                          `(Fuzzy search completed in ${executionTime.toFixed(2)}ms)\n\n` +
                          `Closest region in file:\n${groundTruth}\n\n` +
                          `Tip: copy a UNIQUE fragment of the actual content above as your new old_string, or use read_file with offset around those lines for more context.\n\n` +
                          `Log entry saved for analysis. Use the following command to check the log:\n` +
                          `Check log: ${await fuzzySearchLogger.getLogPath()}`
                }],
            };
        }
    }
    
    throw new Error("Unexpected error during search and replace operation.");
    });  // close withFileLock
}

/**
 * Extract a numbered code block around `anchor` from `content`.
 *
 * When edit_block can't find `old_string` exactly, the AI is left guessing
 * what whitespace / line endings / hidden chars actually live in the file.
 * Returning a real-bytes snapshot of the closest matching region (the fuzzy
 * "value") with line numbers and ±N lines of context lets the AI just
 * copy the actual content as the next attempt's old_string — no extra
 * read_file round-trip needed.
 *
 * Bounded to maxChars (default 1500) so a long fuzzy match doesn't itself
 * become a context-overflow source.
 */
function extractContextAround(content: string, anchor: string, contextLines: number = 5, maxChars: number = 1500): string {
    if (!anchor) return '<no anchor>';
    const idx = content.indexOf(anchor);
    const allLines = content.split('\n');
    if (idx < 0) {
        // Anchor not located byte-for-byte (rare — fuzzy normalization may have
        // altered whitespace). Degrade gracefully: still useful to dump the
        // anchor itself so AI can compare to its own search string.
        const head = anchor.length > maxChars ? anchor.slice(0, maxChars) + `\n... (truncated, full ${anchor.length} chars)` : anchor;
        return `<closest fuzzy match (anchor not byte-located in file; ${anchor.length} chars):>\n${head}`;
    }
    const startLine = content.slice(0, idx).split('\n').length;
    const endLine = content.slice(0, idx + anchor.length).split('\n').length;
    const fromLine = Math.max(1, startLine - contextLines);
    const toLine = Math.min(allLines.length, endLine + contextLines);
    const slice = allLines.slice(fromLine - 1, toLine);
    const numWidth = String(toLine).length;
    const numbered = slice.map((line, i) => `${String(fromLine + i).padStart(numWidth, ' ')}  ${line}`).join('\n');
    if (numbered.length > maxChars) {
        return numbered.slice(0, maxChars) + `\n... (truncated; full block is ${slice.length} lines, ${numbered.length} chars)`;
    }
    return `Lines ${fromLine}-${toLine} (closest match at lines ${startLine}-${endLine}):\n${numbered}`;
}

/**
 * Generates a character-level diff using standard {-removed-}{+added+} format
 * @param expected The string that was searched for
 * @param actual The string that was found
 * @returns A formatted string showing character-level differences
 */
function highlightDifferences(expected: string, actual: string): string {
    // Implementation of a simplified character-level diff
    
    // Find common prefix and suffix
    let prefixLength = 0;
    const minLength = Math.min(expected.length, actual.length);

    // Determine common prefix length
    while (prefixLength < minLength &&
           expected[prefixLength] === actual[prefixLength]) {
        prefixLength++;
    }

    // Determine common suffix length
    let suffixLength = 0;
    while (suffixLength < minLength - prefixLength &&
           expected[expected.length - 1 - suffixLength] === actual[actual.length - 1 - suffixLength]) {
        suffixLength++;
    }
    
    // Extract the common and different parts
    const commonPrefix = expected.substring(0, prefixLength);
    const commonSuffix = expected.substring(expected.length - suffixLength);

    const expectedDiff = expected.substring(prefixLength, expected.length - suffixLength);
    const actualDiff = actual.substring(prefixLength, actual.length - suffixLength);

    // Format the output as a character-level diff
    return `${commonPrefix}{-${expectedDiff}-}{+${actualDiff}+}${commonSuffix}`;
}

/**
 * Handle edit_block command
 *
 * 1. Text files: String replacement (old_string/new_string)
 *    - Uses fuzzy matching for resilience
 *    - Handles expected_replacements parameter
 *
 * 2. Structured files (Excel): Range rewrite (range + content)
 *    - Bulk updates to cell ranges (e.g., "Sheet1!A1:C10")
 *    - Whole sheet replacement (e.g., "Sheet1")
 *    - More powerful and simpler than surgical location-based edits
 *    - Supports chunking for large datasets (e.g., 1000 rows at a time)

 */
export async function handleEditBlock(args: unknown): Promise<ServerResult> {
    const parsed = EditBlockArgsSchema.parse(args);

    // Note: Check for truthy range to handle empty strings from AI clients that send all optional params
    const hasRange = parsed.range !== undefined && parsed.range !== '';
    const hasContent = parsed.content !== undefined && parsed.content !== '';

    // Validate path and resolve handler once — used by both dispatch paths below
    let validatedPath: string;
    let handler: Awaited<ReturnType<typeof import('../utils/files/factory.js').getFileHandler>>;
    try {
        validatedPath = await validatePath(parsed.file_path);
        const { getFileHandler } = await import('../utils/files/factory.js');
        handler = await getFileHandler(validatedPath);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }

    const hasEditRange = 'editRange' in handler && typeof handler.editRange === 'function';

    // Path 1: Range rewrite (Excel, etc.) — range + content
    if (hasRange && hasContent) {
        // Parse content if it's a JSON string (AI often sends arrays as JSON strings)
        let content = parsed.content;
        if (typeof content === 'string') {
            try {
                content = JSON.parse(content);
            } catch {
                // Leave as-is if not valid JSON - let handler decide
            }
        }

        if (hasEditRange) {
            try {
                // parsed.range is guaranteed non-empty string by hasRange check above
                await handler.editRange!(validatedPath!, parsed.range!, content, parsed.options);
                const resolvedRangePath = resolveAbsolutePath(parsed.file_path);
                return {
                    content: [{
                        type: "text",
                        text: `Successfully updated range ${parsed.range} in ${parsed.file_path}`
                    }],
                    structuredContent: {
                        fileName: path.basename(resolvedRangePath),
                        filePath: resolvedRangePath,
                        fileType: resolvePreviewFileType(resolvedRangePath),
                        sourceTool: 'edit_block',
                        ...await getDefaultEditorMetadata(resolvedRangePath),
                    },
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return createErrorResponse(errorMessage);
            }
        }

        return createErrorResponse(`Range-based editing not supported for ${parsed.file_path}. For text files, use old_string and new_string parameters instead. If your client requires range/content parameters, set them to empty strings ("").`);
    }

    // Path 2: Text replacement — old_string + new_string
    if (parsed.old_string === undefined || parsed.new_string === undefined) {
        return createErrorResponse(`Text replacement requires both old_string and new_string parameters`);
    }

    // If the handler implements editRange it owns text-replacement for its file type
    // (e.g. DocxFileHandler does find/replace on pretty-printed XML rather than raw bytes).
    // Plain text files fall through to performSearchReplace.
    if (hasEditRange) {
        try {
            const result = await handler.editRange!(validatedPath!, '', {
                old_string: parsed.old_string,
                new_string: parsed.new_string,
                expected_replacements: parsed.expected_replacements,
            });

            if (result.success) {
                const resolvedEditRangePath = resolveAbsolutePath(parsed.file_path);
                return {
                    content: [{
                        type: "text",
                        text: `Successfully applied ${result.editsApplied} edit(s) to ${parsed.file_path}`
                    }],
                    structuredContent: {
                        fileName: path.basename(resolvedEditRangePath),
                        filePath: resolvedEditRangePath,
                        fileType: resolvePreviewFileType(resolvedEditRangePath),
                        sourceTool: 'edit_block',
                        ...await getDefaultEditorMetadata(resolvedEditRangePath),
                    },
                };
            }

            const errorMsg = result.errors?.map(e => e.error).join('; ') || 'Unknown error';
            return createErrorResponse(errorMsg);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return createErrorResponse(errorMessage);
        }
    }

    return performSearchReplace(parsed.file_path, {
        search: parsed.old_string,
        replace: parsed.new_string
    }, parsed.expected_replacements);
}

/**
 * One edit in a batch request (text search/replace only).
 */
export interface MultiEditInput {
    file_path: string;
    old_string: string;
    new_string: string;
    expected_replacements?: number;
}

interface PerEditResult {
    index: number;        // index within this file's edit list (0-based)
    ok: boolean;
    count: number;        // exact occurrences found
    reason?: string;      // failure reason
    hint?: string;        // closest-match context on a miss
}

/**
 * edit_block_multiple — batch surgical text edits across many files/positions
 * in ONE call. The batch counterpart of write_multiple_files (which already
 * covers batch CREATE); use this for batch EDIT.
 *
 * Semantics:
 *  - Edits are grouped by file; each file is read once, all its edits applied
 *    in memory (sequentially, each on the running content), then written ONCE.
 *  - PER-FILE ATOMIC: if any edit in a file fails to match exactly, that file
 *    is left completely untouched (nothing written) and the failures reported.
 *  - CROSS-FILE INDEPENDENT + concurrent: a failure in one file never affects
 *    another; different files run in parallel (per-path lock prevents races).
 *  - Plain-text search/replace only (same engine as edit_block's text path).
 *    For Excel/DOCX structured edits, use edit_block per file.
 */
export async function editBlockMultiple(edits: MultiEditInput[]): Promise<ServerResult> {
    capture('server_edit_block_multiple', { editCount: edits.length });

    // Group by file path, preserving per-file edit order.
    const groups = new Map<string, MultiEditInput[]>();
    for (const e of edits) {
        const key = e.file_path;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(e);
    }

    interface FileOutcome {
        file_path: string;
        ok: boolean;            // file written (all edits applied)
        appliedCount: number;   // edits applied in memory
        editResults: PerEditResult[];
        error?: string;         // file-level error (e.g. path/read failure)
    }

    const runFile = async (file_path: string, fileEdits: MultiEditInput[]): Promise<FileOutcome> => {
        let validPath: string;
        try {
            validPath = await validatePath(file_path);
        } catch (error) {
            return {
                file_path, ok: false, appliedCount: 0,
                editResults: fileEdits.map((_, i) => ({ index: i, ok: false, count: 0, reason: 'invalid/forbidden path' })),
                error: error instanceof Error ? error.message : String(error),
            };
        }

        return withFileLock(validPath, async () => {
            let content: string;
            try {
                const read = await readFileInternal(validPath, 0, Number.MAX_SAFE_INTEGER);
                if (typeof read !== 'string') throw new Error('file content is not text');
                content = read;
            } catch (error) {
                return {
                    file_path, ok: false, appliedCount: 0,
                    editResults: fileEdits.map((_, i) => ({ index: i, ok: false, count: 0, reason: 'read failed' })),
                    error: error instanceof Error ? error.message : String(error),
                };
            }

            const lineEnding = detectLineEnding(content);
            let running = content;
            const editResults: PerEditResult[] = [];
            let allOk = true;

            for (let i = 0; i < fileEdits.length; i++) {
                const ed = fileEdits[i];
                const expected = ed.expected_replacements ?? 1;
                if (!ed.old_string) {
                    editResults.push({ index: i, ok: false, count: 0, reason: 'empty old_string' });
                    allOk = false;
                    continue;
                }
                if (ed.new_string === undefined) {
                    editResults.push({ index: i, ok: false, count: 0, reason: 'missing new_string' });
                    allOk = false;
                    continue;
                }
                const res = exactReplaceInContent(running, ed.old_string, ed.new_string, expected, lineEnding);
                if (res.applied) {
                    running = res.newContent;
                    editResults.push({ index: i, ok: true, count: res.count });
                } else {
                    allOk = false;
                    let reason: string;
                    let hint: string | undefined;
                    if (res.count === 0) {
                        reason = 'no exact match';
                        // Fuzzy hint so the AI can fix the search string without a round-trip.
                        try {
                            const fuzzy = await runFuzzySearchInWorker(running, ed.old_string);
                            const sim = getSimilarityRatio(ed.old_string, fuzzy.value);
                            hint = `closest ${Math.round(sim * 100)}% match:\n${extractContextAround(running, fuzzy.value)}`;
                        } catch { /* hint is best-effort */ }
                    } else {
                        reason = `found ${res.count} occurrence(s) but expected ${expected} — set expected_replacements=${res.count} or make old_string more unique`;
                    }
                    editResults.push({ index: i, ok: false, count: res.count, reason, hint });
                }
            }

            // Per-file atomic: only write when every edit applied.
            if (allOk) {
                try {
                    const handler = await getFileHandler(validPath);
                    await handler.write(validPath, running, 'rewrite');
                } catch (error) {
                    return {
                        file_path, ok: false, appliedCount: editResults.filter(r => r.ok).length, editResults,
                        error: `write failed: ${error instanceof Error ? error.message : String(error)}`,
                    };
                }
            }

            return {
                file_path,
                ok: allOk,
                appliedCount: editResults.filter(r => r.ok).length,
                editResults,
            };
        });
    };

    const outcomes = await Promise.all(
        Array.from(groups.entries()).map(([fp, fe]) => runFile(fp, fe))
    );

    const filesOk = outcomes.filter(o => o.ok).length;
    const filesFail = outcomes.length - filesOk;
    const editsApplied = outcomes.reduce((n, o) => n + (o.ok ? o.appliedCount : 0), 0);
    const editsFailed = outcomes.reduce((n, o) => n + o.editResults.filter(r => !r.ok).length, 0);

    const lines: string[] = [];
    for (const o of outcomes) {
        if (o.ok) {
            lines.push(`✅ ${o.file_path} (${o.appliedCount} edit${o.appliedCount === 1 ? '' : 's'} applied)`);
        } else {
            const failed = o.editResults.filter(r => !r.ok);
            const head = o.error
                ? `❌ ${o.file_path} — ${o.error} (file unchanged)`
                : `❌ ${o.file_path} — ${failed.length} edit(s) failed, file left unchanged (per-file atomic)`;
            lines.push(head);
            for (const r of failed) {
                lines.push(`   • edit #${r.index + 1}: ${r.reason}`);
                if (r.hint) lines.push(`     ↳ ${r.hint.replace(/\n/g, '\n       ')}`);
            }
        }
    }

    const summary = `Batch edit: ${filesOk}/${outcomes.length} files updated, ${editsApplied} edit(s) applied, ${editsFailed} failed.`;

    return {
        content: [{ type: "text", text: `${summary}\n${lines.join('\n')}` }],
        structuredContent: {
            sourceTool: 'edit_block_multiple',
            totalFiles: outcomes.length,
            filesUpdated: filesOk,
            filesFailed: filesFail,
            editsApplied,
            editsFailed,
            results: outcomes,
        },
        isError: filesFail > 0 && filesOk === 0,
    };
}

/**
 * Handle edit_block_multiple command.
 */
export async function handleEditBlockMultiple(args: unknown): Promise<ServerResult> {
    const parsed = EditBlockMultipleArgsSchema.parse(args);
    return editBlockMultiple(parsed.edits);
}
