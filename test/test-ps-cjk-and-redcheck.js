// Two things this proves that the unit tests can't:
//   1. RED-CHECK: the OLD implementation really did destroy the error text, so
//      the new tests are not vacuous.
//   2. CJK errors come back as readable Chinese, not mojibake (D3), through the
//      real spawn path on this machine's OEM code page.
import { terminalManager } from '../dist/terminal-manager.js';
import { extractClixmlRecords } from '../dist/utils/clixml.js';

let bad = 0;
const check = (ok, msg, extra) => {
  if (!ok) { bad++; console.log(`FAIL | ${msg}`); if (extra) console.log('     ' + extra); }
  else console.log(`PASS | ${msg}`);
};

// ---- 1. RED-CHECK: replay the old deletion regex on a real envelope shape.
const realEnvelope =
  '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
  '<Obj S="progress" RefId="0"><MS><PR N="Record"><AV>Preparing modules</AV></PR></MS></Obj>' +
  '<S S="Error">Get-Item : Cannot find path E:\\no\\such\\zz.txt_x000D__x000A_</S>' +
  '<S S="Error">    + FullyQualifiedErrorId : PathNotFound_x000D__x000A_</S></Objs>';

const OLD = (t) => t.replace(/#< CLIXML\r?\n/g, '').replace(/<Objs [\s\S]*?<\/Objs>/g, '').replace(/^[\r\n]+/, '');
const NEW = (t) => t.replace(/#< CLIXML\r?\n/g, '').replace(/<Objs [\s\S]*?<\/Objs>/g, (b) => extractClixmlRecords(b)).replace(/^[\r\n]+/, '');

const oldOut = OLD(realEnvelope);
const newOut = NEW(realEnvelope);
check(oldOut.trim() === '', 'RED-CHECK: old regex produced EMPTY output (defect reproduced)', JSON.stringify(oldOut));
check(newOut.includes('Cannot find path') && newOut.includes('PathNotFound'),
  'new impl recovers the same text the old one deleted');
check(!newOut.includes('Preparing modules'), 'progress noise still dropped');

// ---- 2. CJK end-to-end through the real shell.
async function run(cmd) {
  const r = await terminalManager.executeCommand(cmd, 25000);
  for (let i = 0; i < 80; i++) {
    const d = terminalManager.listCompletedSessions().find(s => s.pid === r.pid);
    if (d) return { code: d.exitCode, out: d.outputLines.join('\n') };
    await new Promise(res => setTimeout(res, 50));
  }
  throw new Error('never completed: ' + cmd);
}

const cjkErr = await run("Write-Error '错误标记-中文'");
check(cjkErr.out.includes('错误标记-中文'),
  'CJK error text is readable, not mojibake (D3)', JSON.stringify(cjkErr.out.slice(0, 200)));

const cjkOut = await run("Write-Output '正常输出-中文'");
check(cjkOut.out.includes('正常输出-中文'),
  'CJK stdout still correct (no regression from byte decoding)', JSON.stringify(cjkOut.out.slice(0, 200)));

// Mixed CJK + ASCII, large enough to cross a chunk boundary.
const big = await run("1..40 | ForEach-Object { Write-Output \"行$_-中文-abcdefghijklmnop\" }");
const lines = big.out.split('\n').filter(l => l.includes('中文'));
check(lines.length >= 40, `all 40 CJK lines intact across chunk boundaries (got ${lines.length})`);
check(!big.out.includes('\ufffd'), 'no replacement chars (U+FFFD) in decoded CJK output');

console.log(bad === 0 ? '\nALL RED-CHECK + CJK PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
