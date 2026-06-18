import {
    readFile,
    readMultipleFiles,
    writeFile,
    createDirectory,
    listDirectory,
    moveFile,
    getFileInfo,
    writePdf,
    getDefaultEditorMetadata,
    type FileResult,
    type MultiFileResult
} from '../tools/filesystem.js';
import type { ReadOptions } from '../utils/files/base.js';

import { ServerResult } from '../types.js';
import { withTimeout } from '../utils/withTimeout.js';
import { createErrorResponse } from '../error-handlers.js';
import { configManager } from '../config-manager.js';

import {
    ReadFileArgsSchema,
    ReadMultipleFilesArgsSchema,
    WriteFileArgsSchema,
    CreateDirectoryArgsSchema,
    ListDirectoryArgsSchema,
    MoveFileArgsSchema,
    GetFileInfoArgsSchema,
    WritePdfArgsSchema
} from '../tools/schemas.js';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { resolvePreviewFileType } from '../ui/file-preview/shared/preview-file-types.js';

/**
 * Expand home directory (~) in a file path
 */
function expandHome(filePath: string): string {
    if (filePath === '~' || filePath.startsWith('~/') || filePath.startsWith(`~${path.sep}`)) {
        return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
}

/**
 * Resolve a file path to an absolute path for use in structured content.
 * This ensures "Open in folder" always has a valid absolute path.
 */
export function resolveAbsolutePath(filePath: string): string {
    const expanded = expandHome(filePath);
    return path.isAbsolute(expanded)
        ? path.resolve(expanded)
        : path.resolve(process.cwd(), expanded);
}

/**
 * Helper function to check if path contains an error
 */
function isErrorPath(filePath: string): boolean {
    return filePath.startsWith('__ERROR__:');
}

/**
 * Extract error message from error path
 */
function getErrorFromPath(path: string): string {
    return path.substring('__ERROR__:'.length).trim();
}

/**
 * Handle read_file command
 */
export async function handleReadFile(args: unknown): Promise<ServerResult> {
    const HANDLER_TIMEOUT = 60000; // 60 seconds total operation timeout
    // Add input validation
    if (args === null || args === undefined) {
        return createErrorResponse('No arguments provided for read_file command');
    }
    const readFileOperation = async () => {
        const parsed = ReadFileArgsSchema.parse(args);

        // Get the configuration for file read limits
        const config = await configManager.getConfig();
        if (!config) {
            return createErrorResponse('Configuration not available');
        }

        const defaultLimit = config.fileReadLineLimit ?? 1000;

        // Convert sheet parameter: numeric strings become numbers for Excel index access
        let sheetParam: string | number | undefined = parsed.sheet;
        if (parsed.sheet !== undefined && /^\d+$/.test(parsed.sheet)) {
            sheetParam = parseInt(parsed.sheet, 10);
        }

        const options: ReadOptions = {
            isUrl: parsed.isUrl,
            offset: parsed.offset ?? 0,
            length: parsed.length ?? defaultLimit,
            sheet: sheetParam,
            range: parsed.range
        };

        // Resolve to absolute path for local files (not URLs) so "Open in folder" works
        const resolvedFilePath = parsed.isUrl
            ? parsed.path
            : resolveAbsolutePath(parsed.path);

        const fileResult = await readFile(parsed.path, options);

        // Handle PDF files
        if (fileResult.metadata?.isPdf) {
            const meta = fileResult.metadata;
            const author = meta?.author ? `, Author: ${meta?.author}` : "";
            const title = meta?.title ? `, Title: ${meta?.title}` : "";

            const pdfContent = fileResult.metadata?.pages?.flatMap((p: any) => [
                ...(p.images?.map((image: any) => ({
                    type: "image",
                    data: image.data,
                    mimeType: image.mimeType
                })) ?? []),
                {
                    type: "text",
                    text: `<!-- Page: ${p.pageNumber} -->\n${p.text}`,
                },
            ]) ?? [];

            return {
                content: [
                    {
                        type: "text",
                        text: `PDF file: ${parsed.path}${author}${title} (${meta?.totalPages} pages) \n`
                    },
                    ...pdfContent
                ],
                structuredContent: {
                    fileName: path.basename(resolvedFilePath),
                    filePath: resolvedFilePath,
                    fileType: 'unsupported' as const,
                    sourceTool: 'read_file',
                    ...await getDefaultEditorMetadata(resolvedFilePath),
                    content: pdfContent
                        .filter((item): item is { type: "text"; text: string } => item.type === "text")
                        .map((item) => item.text)
                        .join("\n"),
                },
            };
        }

        // Handle image files
        if (fileResult.metadata?.isImage) {
            // Return the image bytes in the MCP content array so the host model can
            // actually see the image. structuredContent additionally carries the bytes
            // for the preview widget to render.
            const imageData = typeof fileResult.content === 'string'
                ? fileResult.content
                : fileResult.content.toString('base64');
            const imageSummary = `Image file: ${parsed.path} (${fileResult.mimeType})\n`;
            return {
                content: [
                    {
                        type: "text",
                        text: imageSummary
                    },
                    {
                        type: "image",
                        data: imageData,
                        mimeType: fileResult.mimeType
                    }
                ],
                structuredContent: {
                    fileName: path.basename(resolvedFilePath),
                    filePath: resolvedFilePath,
                    fileType: 'image',
                    sourceTool: 'read_file',
                    ...await getDefaultEditorMetadata(resolvedFilePath),
                    content: imageData,
                    imageData,
                    mimeType: fileResult.mimeType
                }
            };
        } else {
            // For all other files, return as text.
            // structuredContent carries only file metadata (no content duplication);
            // the widget reads text from the MCP content array.
            const textContent = typeof fileResult.content === 'string'
                ? fileResult.content
                : fileResult.content.toString('utf8');
            const fileType = fileResult.metadata?.isDirectory ? 'directory' as const : resolvePreviewFileType(resolvedFilePath);
            return {
                content: [{ type: "text", text: textContent }],
                structuredContent: {
                    fileName: path.basename(resolvedFilePath),
                    filePath: resolvedFilePath,
                    fileType,
                    sourceTool: 'read_file',
                    ...await getDefaultEditorMetadata(resolvedFilePath),
                    content: textContent,
                },
            };
        }
    };

    // Execute with timeout at the handler level
    const result = await withTimeout(
        readFileOperation(),
        HANDLER_TIMEOUT,
        'Read file handler operation',
        null
    );
    if (result == null) {
        // Handles the impossible case where withTimeout resolves to null instead of throwing
        throw new Error('Failed to read the file');
    }
    return result;
}

/**
 * Handle read_multiple_files command
 */
export async function handleReadMultipleFiles(args: unknown): Promise<ServerResult> {
    const parsed = ReadMultipleFilesArgsSchema.parse(args);
    const fileResults = await readMultipleFiles(parsed.paths);

    // Create a text summary of all files
    const textSummary = fileResults.map(result => {
        if (result.error) {
            return `${result.path}: Error - ${result.error}`;
        } else if (result.isPdf) {
            return `${result.path}: PDF file with ${result.payload?.pages?.length} pages`;
        } else if (result.mimeType) {
            return `${result.path}: ${result.mimeType} ${result.isImage ? '(image)' : '(text)'}`;
        } else {
            return `${result.path}: Unknown type`;
        }
    }).join("\n");

    // Create content items for each file
    const contentItems: Array<{ type: string, text?: string, data?: string, mimeType?: string }> = [];

    // Add the text summary
    contentItems.push({ type: "text", text: textSummary });

    // Add each file content
    for (const result of fileResults) {
        if (!result.error && result.content !== undefined) {
            if (result.isPdf) {
                result.payload?.pages.forEach((page, i) => {
                    page.images.forEach((image, i) => {
                        contentItems.push({
                            type: "image",
                            data: image.data,
                            mimeType: image.mimeType
                        });
                    });
                    contentItems.push({
                        type: "text",
                        text: page.text,
                    });
                });
            } else if (result.isImage && result.mimeType) {
                // For image files, add an image content item
                contentItems.push({
                    type: "image",
                    data: result.content,
                    mimeType: result.mimeType
                });
            } else {
                // For text files, add a text summary
                contentItems.push({
                    type: "text",
                    text: `\n--- ${result.path} contents: ---\n${result.content}`
                });
            }
        }
    }

    return { content: contentItems };
}

/**
 * Handle write_file command
 */
export async function handleWriteFile(args: unknown): Promise<ServerResult> {
    try {
        const parsed = WriteFileArgsSchema.parse(args);

        // Get the line limit from configuration
        const config = await configManager.getConfig();
        const MAX_LINES = config.fileWriteLineLimit ?? 50; // Default to 50 if not set

        // Overwrite protection: when mode='rewrite' and target file already
        // exists, refuse unless allowOverwrite=true. Prevents silent full-file
        // overwrites by AI clients that ignore prompt-level rules ("use
        // edit_block / append"). Tightens user-rule §3 from policy to code.
        // Set writeFileOverwriteProtection=false to restore legacy behavior.
        const protectionEnabled = config.writeFileOverwriteProtection !== false;
        if (parsed.mode === 'rewrite' && !parsed.allowOverwrite && protectionEnabled) {
            const resolvedCheckPath = resolveAbsolutePath(parsed.path);
            try {
                const stat = await fs.stat(resolvedCheckPath);
                if (stat.isFile()) {
                    return createErrorResponse(
`⚠️ File already exists: ${parsed.path}
write_file with mode='rewrite' would OVERWRITE the entire file (${stat.size} bytes).

Choose one:
  • Surgical edit (recommended) → use edit_block with old_string + new_string
  • Append at end → call write_file again with mode:'append'
  • Intentional full overwrite → set allowOverwrite:true and retry

Disable this guard globally:
  set_config_value("writeFileOverwriteProtection", false)`
                    );
                }
            } catch (err: any) {
                if (err && err.code !== 'ENOENT') throw err;
                // ENOENT: file doesn't exist; rewrite is safe (creating new file).
            }
        }

        // Strictly enforce line count limit
        const lines = parsed.content.split('\n');
        const lineCount = lines.length;
        let errorMessage = "";
        if (lineCount > MAX_LINES) {
            errorMessage = `✅ File written successfully! (${lineCount} lines)
            
💡 Performance tip: For optimal speed, consider chunking files into ≤30 line pieces in future operations.`;
        }

        // Pass the mode parameter to writeFile
        await writeFile(parsed.path, parsed.content, parsed.mode);

        // Provide more informative message based on mode
        const modeMessage = parsed.mode === 'append' ? 'appended to' : 'wrote to';
        const resolvedWritePath = resolveAbsolutePath(parsed.path);

        return {
            content: [{
                type: "text",
                text: `Successfully ${modeMessage} ${parsed.path} (${lineCount} lines) ${errorMessage}`
            }],
            structuredContent: {
                fileName: path.basename(resolvedWritePath),
                filePath: resolvedWritePath,
                fileType: resolvePreviewFileType(resolvedWritePath),
                sourceTool: 'write_file',
                ...await getDefaultEditorMetadata(resolvedWritePath),
            },
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

/**
 * Handle create_directory command
 */
export async function handleCreateDirectory(args: unknown): Promise<ServerResult> {
    try {
        const parsed = CreateDirectoryArgsSchema.parse(args);
        await createDirectory(parsed.path);
        return {
            content: [{ type: "text", text: `Successfully created directory ${parsed.path}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

/**
 * Handle list_directory command
 *
 * Pagination + char cap defense against host context overflow. Kiro IDE doesn't
 * auto-truncate tool responses, so listing a folder with thousands of entries
 * blows up the conversation window. Two layers of protection:
 *   1. Entry-level pagination (offset/limit) — top-level entries cap.
 *   2. Char-level cap (responseMaxChars) — last-resort tail trim, snaps to
 *      a clean newline boundary so partial entries aren't shown.
 */
export async function handleListDirectory(args: unknown): Promise<ServerResult> {
    try {
        const startTime = Date.now();
        const parsed = ListDirectoryArgsSchema.parse(args);
        const config = await configManager.getConfig();
        const responseMaxChars = config.responseMaxChars ?? 50000;
        const defaultLimit = config.fileReadLineLimit ?? 1000;
        const limit = parsed.limit ?? defaultLimit;
        const offset = parsed.offset ?? 0;

        const allEntries = await listDirectory(parsed.path, parsed.depth);
        const total = allEntries.length;
        const sliced = allEntries.slice(offset, offset + limit);
        const duration = Date.now() - startTime;

        let resultText = sliced.join('\n');
        let charTruncated = false;
        if (resultText.length > responseMaxChars) {
            // Char-level cap: trim tail, snap to last newline so we don't cut
            // a path mid-name. Threshold of 50% prevents pathological cases
            // where a single huge line forces dropping everything.
            let trimmed = resultText.slice(0, responseMaxChars);
            const lastNl = trimmed.lastIndexOf('\n');
            if (lastNl > responseMaxChars * 0.5) trimmed = trimmed.slice(0, lastNl);
            resultText = trimmed;
            charTruncated = true;
        }

        const shownEnd = offset + sliced.length;
        const remainingEntries = Math.max(0, total - shownEnd);
        let hintLines: string[] = [];
        if (sliced.length === 0 && total > 0) {
            hintLines.push(`[Empty page: offset=${offset} is beyond ${total} total entries. Try offset=0.]`);
        } else if (charTruncated || remainingEntries > 0) {
            const parts: string[] = [];
            parts.push(`showing entries ${offset}..${shownEnd - 1} of ${total} total`);
            if (charTruncated) parts.push(`output capped at ${responseMaxChars} chars`);
            if (remainingEntries > 0) parts.push(`use offset=${shownEnd} limit=${limit} to fetch more`);
            hintLines.push(`\n[Listing truncated: ${parts.join('; ')}]`);
        } else if (offset > 0) {
            hintLines.push(`\n[Showing entries ${offset}..${shownEnd - 1} of ${total} total]`);
        }
        const finalText = resultText + (hintLines.length ? '\n' + hintLines.join('\n') : '');
        const resolvedPath = resolveAbsolutePath(parsed.path);

        return {
            content: [{ type: "text", text: finalText }],
            structuredContent: {
                fileName: path.basename(resolvedPath),
                filePath: resolvedPath,
                fileType: 'directory' as const,
                sourceTool: 'list_directory',
                // Carry the listing in structuredContent too. Chat reads the text
                // content array, but structuredContent-only consumers (e.g. Cowork)
                // render from here and would otherwise show an empty directory.
                content: finalText,
            },
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

/**
 * Handle move_file command
 */
export async function handleMoveFile(args: unknown): Promise<ServerResult> {
    try {
        const parsed = MoveFileArgsSchema.parse(args);
        await moveFile(parsed.source, parsed.destination);
        return {
            content: [{ type: "text", text: `Successfully moved ${parsed.source} to ${parsed.destination}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

/**
 * Format a value for display, handling objects and arrays
 */
function formatValue(value: unknown, indent: string = ''): string {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        // For arrays of objects (like sheets), format each item
        const items = value.map((item, i) => {
            if (typeof item === 'object' && item !== null) {
                const props = Object.entries(item)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ');
                return `${indent}  [${i}] { ${props} }`;
            }
            return `${indent}  [${i}] ${item}`;
        });
        return `\n${items.join('\n')}`;
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

/**
 * Handle get_file_info command
 */
export async function handleGetFileInfo(args: unknown): Promise<ServerResult> {
    try {
        const parsed = GetFileInfoArgsSchema.parse(args);
        const info = await getFileInfo(parsed.path);

        // Generic formatting for any file type
        const formattedText = Object.entries(info)
            .map(([key, value]) => `${key}: ${formatValue(value)}`)
            .join('\n');

        return {
            content: [{
                type: "text",
                text: formattedText
            }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

// Use get_config to retrieve the allowedDirectories configuration

/**
 * Handle write_pdf command
 */
export async function handleWritePdf(args: unknown): Promise<ServerResult> {
    try {
        const parsed = WritePdfArgsSchema.parse(args);
        await writePdf(parsed.path, parsed.content, parsed.outputPath, parsed.options);
        const targetPath = parsed.outputPath || parsed.path;
        return {
            content: [{ type: "text", text: `Successfully wrote PDF to ${targetPath}${parsed.outputPath ? `\nOriginal file: ${parsed.path}` : ''}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}
