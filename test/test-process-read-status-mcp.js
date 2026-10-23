/**
 * read_process_output's status block through the real server over stdio
 * (dist/index.js), as an MCP client sees it: start_process with watch_paths,
 * empty reads with hints and the candidate file, then wait_until="exit".
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runIfMain } from './helpers/run-if-main.js';
import { closeClient } from './helpers/close-client.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textOf = (result) => result.content?.find((block) => block.type === 'text')?.text ?? '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function runTests() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-read-status-mcp-')));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const script = path.join(dir, 'job.js');
  fs.writeFileSync(script,
    `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(path.join(out, 'result.md'))},'ok'),500);` +
    `setTimeout(()=>console.log('JOB FINISHED'),6000);`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...process.env },
  });
  const client = new Client({ name: 'read-status-mcp-test', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: 30_000 });
    const { tools } = await client.listTools();
    const readTool = tools.find((tool) => tool.name === 'read_process_output');
    assert.deepStrictEqual(readTool.inputSchema.properties.wait_until.enum, ['output', 'exit'], 'wait_until is in the schema');
    assert(tools.find((tool) => tool.name === 'start_process').inputSchema.properties.watch_paths, 'watch_paths is in the schema');

    const started = await client.callTool({
      name: 'start_process',
      arguments: { command: `node ${JSON.stringify(script)}`, timeout_ms: 500, cwd: dir, watch_paths: [out] },
    });
    const pid = Number(textOf(started).match(/PID (\d+)/)?.[1]);
    assert(pid, `start_process should start the job: ${textOf(started)}`);
    await sleep(1000);
    const reads = [];
    for (let i = 0; i < 3; i++) {
      reads.push(textOf(await client.callTool({ name: 'read_process_output', arguments: { pid, timeout_ms: 600 } })));
    }
    console.log('--- third read as the client sees it ---\n' + reads[2] + '\n---');
    assert.match(reads[0], /\[process\] state=running/, reads[0]);
    assert.match(reads[2], /empty_reads_in_a_row=3/, reads[2]);
    assert.match(reads[2], /files: changed_since_start=1\n\s+\S*result\.md 2B @/, reads[2]);
    assert.match(reads[2], /\[hint\] 3 reads in a row returned no output/, reads[2]);
    const final = textOf(await client.callTool({ name: 'read_process_output', arguments: { pid, timeout_ms: 20000, wait_until: 'exit' } }));
    console.log('--- wait_until=exit ---\n' + final + '\n---');
    assert.match(final, /JOB FINISHED/, final);
    assert.match(final, /state=exited/, final);
    assert.match(final, /integrity=complete/, final);
  } finally {
    await closeClient(client);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log('✓ over MCP stdio: status block, hints, candidate file, wait_until=exit');
  return true;
}

runIfMain(import.meta.url, runTests);
