// D2 verification: the four exit-code cases, incl. the sticky-$LASTEXITCODE
// regression. Uses dist/terminal-manager so it exercises the real wrapper.
import { terminalManager } from '../dist/terminal-manager.js';

const NODE = `& "${process.execPath}"`;

async function exitCodeOf(cmd) {
  const r = await terminalManager.executeCommand(cmd, 25000);
  for (let i = 0; i < 80; i++) {
    const done = terminalManager.listCompletedSessions().find(s => s.pid === r.pid);
    if (done) return { code: done.exitCode, out: done.outputLines.join('\n') };
    await new Promise(res => setTimeout(res, 50));
  }
  throw new Error('never completed: ' + cmd);
}

const cases = [
  ['native non-zero survives',        `${NODE} -e "process.exit(7)"`,                        c => c === 7],
  ['native zero stays zero',          `${NODE} -e "process.exit(0)"`,                        c => c === 0],
  ['plain cmdlet success is zero',    'Write-Output hello',                                  c => c === 0],
  ['unknown command fails',           'nonexistentcommand_xyz123',                           c => c !== 0],
  ['failing cmdlet fails',            "Get-Item 'E:\\no\\such\\zz.txt'",                     c => c !== 0],
  ['throw fails',                     "Write-Output pre; throw 'boom'",                      c => c !== 0],
  // THE regression: a successful native command leaves $LASTEXITCODE=0, then a
  // cmdlet fails. Pre-fix this reported 0 (silent false success).
  ['sticky LASTEXITCODE after native', `${NODE} -e "process.exit(0)"; Get-Item 'E:\\no\\such\\zz.txt'`, c => c !== 0],
  ['distinct codes stay distinct',    `${NODE} -e "process.exit(127)"`,                      c => c === 127],
];

let bad = 0;
for (const [name, cmd, ok] of cases) {
  const { code, out } = await exitCodeOf(cmd);
  const pass = ok(code);
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'} | exit=${String(code).padEnd(4)} | ${name}`);
  if (!pass) console.log(`     cmd: ${cmd}\n     out: ${JSON.stringify(out.slice(0, 200))}`);
}

// D1 end-to-end: a failing command must now carry its error text.
const errCases = [
  ['unknown command',  'nonexistentcommand_xyz123',           'nonexistentcommand_xyz123'],
  ['failing cmdlet',   "Get-Item 'E:\\no\\such\\zz.txt'",     'zz.txt'],
  ['Write-Error',      "Write-Error 'boom-marker-xyz'",        'boom-marker-xyz'],
  ['piped native err', `${NODE} -e "process.stderr.write('native-marker-xyz')" 2>&1 | Out-String`, 'native-marker-xyz'],
];
console.log('--- D1: error text present in captured output ---');
for (const [name, cmd, needle] of errCases) {
  const { code, out } = await exitCodeOf(cmd);
  const has = out.includes(needle);
  if (!has) bad++;
  console.log(`${has ? 'PASS' : 'FAIL'} | exit=${String(code).padEnd(4)} | ${name} | chars=${out.length}`);
  if (!has) console.log(`     want ${JSON.stringify(needle)} got ${JSON.stringify(out.slice(0, 300))}`);
}

console.log(bad === 0 ? '\nALL D1+D2 E2E PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
