/**
 * write_file / write_multiple_files must tell the caller BEFORE the first call
 * how to replace a file that already has content, so replacing a file is one
 * call rather than a rejected call plus a retry. The typical case is a file
 * the AI itself created earlier in the same conversation: it now exists, so a
 * plain rewrite is refused.
 *
 * The rejection text is unchanged and covered by
 * test-write-file-overwrite-guidance.js; this file checks what the client
 * sees in tools/list: the tool description and the parameter schema.
 */

import assert from 'assert';
import { connectToServer } from './helpers/mcp-client.js';
import { runIfMain } from './helpers/run-if-main.js';

// The same argument set the rejections quote (REPLACE_RETRY_ARGS in filesystem-handlers.ts)
const REPLACE_ARGS = "mode:'rewrite', allowOverwrite:true";

export async function run() {
    const client = await connectToServer('test-client');
    try {
        const { tools } = await client.listTools();
        const writeFile = tools.find((t) => t.name === 'write_file');
        const writeMultiple = tools.find((t) => t.name === 'write_multiple_files');
        assert.ok(writeFile, 'write_file is listed');
        assert.ok(writeMultiple, 'write_multiple_files is listed');

        // 1. The description names the replace arguments and says they go in the first call
        assert.ok(writeFile.description.includes(REPLACE_ARGS),
            `write_file description must quote ${REPLACE_ARGS}`);
        assert.match(writeFile.description, /created earlier/i,
            'write_file description must say a file created earlier in the conversation counts as existing');
        assert.match(writeFile.description, /first call/i,
            'write_file description must say to pass the arguments in the first call, not after a rejection');
        console.log('✓ write_file description: replace args, created-earlier case, first call');

        // 2. The parameter itself carries the rule, where a caller filling arguments looks
        const allowOverwrite = writeFile.inputSchema?.properties?.allowOverwrite;
        assert.ok(allowOverwrite?.description?.includes("mode:'rewrite'"),
            `write_file allowOverwrite needs a description naming mode:'rewrite', got ${JSON.stringify(allowOverwrite)}`);
        const mode = writeFile.inputSchema?.properties?.mode;
        assert.ok(mode?.description?.includes('allowOverwrite'),
            `write_file mode needs a description naming allowOverwrite, got ${JSON.stringify(mode)}`);
        console.log('✓ write_file schema: mode and allowOverwrite describe each other');

        // 3. Same rule on the batch tool
        assert.ok(writeMultiple.description.includes('allowOverwrite:true'),
            'write_multiple_files description must name allowOverwrite:true');
        assert.match(writeMultiple.description, /created earlier/i,
            'write_multiple_files description must cover files created earlier in the conversation');
        const entry = writeMultiple.inputSchema?.properties?.files?.items?.properties?.allowOverwrite;
        assert.ok(entry?.description?.includes("mode:'rewrite'"),
            `write_multiple_files files[].allowOverwrite needs a description, got ${JSON.stringify(entry)}`);
        console.log('✓ write_multiple_files: description and per-entry allowOverwrite');
    } finally {
        await client.close();
    }
    return true;
}

runIfMain(import.meta.url, run);
