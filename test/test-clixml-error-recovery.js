/**
 * PowerShell CLIXML error-record RECOVERY + exit-code correctness.
 *
 * Guards three defects that together made a failed Windows command look like a
 * silent success (empty output + exit code 0):
 *
 *   D1  filterCliXmlStream deleted whole <Objs>...</Objs> envelopes. Those
 *       envelopes carry BOTH progress noise AND the real <S S="Error"> text,
 *       so every PS-error-stream message was destroyed. Now: progress records
 *       are dropped, error/warning/info records are decoded back to text.
 *   D2  $LASTEXITCODE is sticky — a native command leaves it 0, so a LATER
 *       failing cmdlet exited 0. Now $? is consulted first.
 *   D3  CLIXML payload is OEM(GBK)-encoded regardless of our UTF-8 prefix, so
 *       CJK errors arrived mojibake. Now stderr is decoded per code page.
 *
 * Auto-discovered by run-all-tests.js.
 */
import { terminalManager } from '../dist/terminal-manager.js';
import { decodeShellBytes, extractClixmlRecords, incompleteTailLength, ShellByteDecoder } from '../dist/utils/clixml.js';

const c = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', blue: '\x1b[34m' };
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`${c.green}  ✓ ${msg}${c.reset}`);
  else { console.log(`${c.red}  ✗ ${msg}${c.reset}`); failures++; }
}

function newSession(strip = true) {
  return { stripCliXml: strip, cliXmlCarry: '' };
}
const filt = (s, t) => terminalManager['filterCliXmlStream'](s, t);

// Real capture shape from PS 5.1 (progress records + error records in ONE envelope).
const PROGRESS =
  '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN>' +
  '<MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules</AV><AI>0</AI>' +
  '<T>Completed</T></PR></MS></Obj>';
const ERR1 = '<S S="Error">this-cmd-xyz : The term \'this-cmd-xyz\' is not recognized._x000D__x000A_</S>';
const ERR2 = '<S S="Error">    + FullyQualifiedErrorId : CommandNotFoundException_x000D__x000A_</S>';
const envelope = (inner) =>
  `#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">${inner}</Objs>`;

function run() {
  console.log(`${c.blue}=== CLIXML error-record recovery (D1/D3) ===${c.reset}`);

  // 1. THE headline regression: error text must survive, progress must not.
  {
    const s = newSession();
    const out = filt(s, envelope(PROGRESS + ERR1 + ERR2));
    assert(out.includes('this-cmd-xyz') && out.includes('not recognized'),
      'error record text is RECOVERED (was deleted before the fix)');
    assert(out.includes('CommandNotFoundException'), 'second error record recovered too');
    assert(!out.includes('Preparing modules'), 'progress record still dropped as noise');
    assert(!out.includes('<Objs') && !out.includes('<S S=') && !out.includes('CLIXML'),
      'no raw XML / header leaks into the buffer');
    assert(s.cliXmlCarry === '', 'carry cleared');
  }

  // 2. _xNNNN_ escapes decode to real newlines, not literal junk.
  {
    const s = newSession();
    const out = filt(s, envelope(ERR1));
    assert(!out.includes('_x000D_') && !out.includes('_x000A_'), '_xNNNN_ escapes decoded');
    assert(out.endsWith('\n'), 'recovered record ends with a real newline');
  }

  // 3. XML entities inside error text survive intact.
  {
    const s = newSession();
    const out = filt(s, envelope('<S S="Error">bad &lt;tag&gt; &amp; &quot;quote&quot;_x000D__x000A_</S>'));
    assert(out.includes('bad <tag> & "quote"'), 'XML entities unescaped');
  }

  // 4. Warning/Information records are kept as well (same loss class).
  {
    const s = newSession();
    const out = filt(s, envelope('<S S="Warning">deprecated-flag-used_x000D__x000A_</S>'));
    assert(out.includes('deprecated-flag-used'), 'warning record recovered');
  }

  // 5. Cross-chunk split INSIDE an error record still recovers the text.
  {
    const s = newSession();
    const a = filt(s, `#< CLIXML\r\n<Objs Version="1.1.0.1">${PROGRESS}<S S="Error">split-err`);
    assert(!a.includes('split-err'), 'incomplete record held in carry, no partial XML emitted');
    const b = filt(s, 'or-marker_x000D__x000A_</S></Objs>\nplain-after\n');
    assert(b.includes('split-error-marker'), 'record spanning two chunks recovered whole');
    assert(b.includes('plain-after'), 'following plain text kept');
    assert(s.cliXmlCarry === '', 'carry cleared after close');
  }

  // 6. Interleaving: plain stdout text around an envelope is preserved in order.
  {
    const s = newSession();
    const out = filt(s, `OUT-A\n${envelope(PROGRESS + ERR1)}\nOUT-C\n`);
    const iA = out.indexOf('OUT-A'), iE = out.indexOf('this-cmd-xyz'), iC = out.indexOf('OUT-C');
    assert(iA >= 0 && iE > iA && iC > iE, 'order preserved: stdout, recovered error, stdout');
  }

  // 7. Non-PS sessions untouched.
  {
    const s = newSession(false);
    const raw = envelope(PROGRESS + ERR1);
    assert(filt(s, raw) === raw, 'stripCliXml=false passes through verbatim');
  }

  console.log(`${c.blue}=== decode helpers (D3: OEM/GBK payload) ===${c.reset}`);

  // 8. GBK-encoded CLIXML payload decodes to real CJK, not mojibake.
  {
    // "无法将" in GBK (cp936) — what PS 5.1 actually puts on the wire.
    const gbk = Buffer.from([0xce, 0xde, 0xb7, 0xa8, 0xbd, 0xab]);
    const decoded = decodeShellBytes(gbk, 'gbk');
    assert(decoded === '无法将', `GBK payload decoded to CJK (got ${JSON.stringify(decoded)})`);
  }

  // 9. Genuine UTF-8 must NOT be mangled by the fallback.
  {
    const u8 = Buffer.from('无法将中文 ok', 'utf8');
    assert(decodeShellBytes(u8, 'gbk') === '无法将中文 ok', 'valid UTF-8 passes through unchanged');
  }

  // 10. Pure ASCII is stable under either path.
  {
    assert(decodeShellBytes(Buffer.from('plain ascii', 'utf8'), 'gbk') === 'plain ascii', 'ASCII stable');
  }

  // 10b. A multi-byte char split across chunks must not corrupt — the exact
  // failure mode that made a valid-UTF-8 stream look invalid for one chunk.
  {
    const full = Buffer.from('中文abc', 'utf8');
    const d = new ShellByteDecoder('gbk');
    let acc = '';
    for (let i = 0; i < full.length; i++) acc += d.write(full.subarray(i, i + 1));
    acc += d.flush();
    assert(acc === '中文abc', `byte-at-a-time UTF-8 reassembles (got ${JSON.stringify(acc)})`);
  }

  // 10c. GBK split across chunks likewise.
  {
    const gbk = Buffer.from([0xce, 0xde, 0xb7, 0xa8]);
    const d = new ShellByteDecoder('gbk');
    let acc = d.write(gbk.subarray(0, 1)) + d.write(gbk.subarray(1, 3)) + d.write(gbk.subarray(3));
    acc += d.flush();
    assert(acc === '无法', `split GBK reassembles (got ${JSON.stringify(acc)})`);
  }

  // 10d. Complete input must never be withheld as a false "incomplete tail".
  {
    assert(incompleteTailLength(Buffer.from('done\n', 'utf8')) === 0, 'ASCII tail not carried');
    assert(incompleteTailLength(Buffer.from('中', 'utf8')) === 0, 'complete UTF-8 char not carried');
    assert(incompleteTailLength(Buffer.from([0xe4, 0xb8])) === 2, 'partial UTF-8 char carried');
  }

  // 11. Record extractor keeps only the streams we want.
  {
    const r = extractClixmlRecords(`<Objs>${PROGRESS}${ERR1}</Objs>`);
    assert(r.includes('not recognized') && !r.includes('Preparing modules'),
      'extractClixmlRecords: errors in, progress out');
  }

  if (failures > 0) { console.log(`${c.red}\n${failures} failed${c.reset}`); process.exit(1); }
  console.log(`${c.green}\nAll CLIXML recovery tests passed${c.reset}`);
  process.exit(0);
}

run();
