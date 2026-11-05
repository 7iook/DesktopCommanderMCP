// Real clock/tool integration, deliberately opt-in (about four minutes).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startProcess, readProcessOutput, forceTerminate } from '../../dist/tools/improved-process-tools.js';

const textOf = result => result.content?.find(block => block.type === 'text')?.text ?? '';
const pids = [];
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-quiet-realtime-'));
try {
  for (const code of ['setTimeout(()=>{},400000)', 'while(true){}']) {
    const result = await startProcess({ command: `node -e "${code}"`, cwd, timeout_ms: 300, watch_paths: [cwd] }, 300);
    assert(result.structuredContent?.pid, textOf(result));
    pids.push(result.structuredContent.pid);
  }
  let idle = '';
  for (let i = 0; i < 5; i++) {
    const results = await Promise.all(pids.map(pid => readProcessOutput({ pid, timeout_ms: 60000, wait_until: 'exit' })));
    idle = textOf(results[0]);
    const busy = textOf(results[1]);
    console.log(`READ ${i + 1} IDLE${idle}\nBUSY${busy}`);
    assert(!busy.includes('quiet_for='), busy);
  }
  assert.match(idle, /quiet_for=/);
  assert.match(idle, /outside the tree/);
} finally {
  for (const pid of pids) await forceTerminate({ pid });
}
