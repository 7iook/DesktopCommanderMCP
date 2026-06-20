// Test PowerShell CLIXML streaming filter on the session ring buffer.
// Directly exercises the write-boundary filter (incl. cross-chunk carry).
// Auto-discovered by run-all-tests.js.
import { terminalManager } from '../dist/terminal-manager.js';

const c = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m' };
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`${c.green}  ✓ ${msg}${c.reset}`);
  else { console.log(`${c.red}  ✗ ${msg}${c.reset}`); failures++; }
}

// Fresh fake session each test. filter is a private method; access via [].
function newSession(strip = true) {
  return { stripCliXml: strip, cliXmlCarry: '' };
}
function filt(s, text) {
  return terminalManager['filterCliXmlStream'](s, text);
}

const OBJS = '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress"><T>Completed</T></Obj></Objs>';

function run() {
  console.log(`${c.blue}=== CLIXML ring-buffer filter ===${c.reset}`);

  // 1. Complete envelope fully stripped, real text kept.
  {
    const s = newSession();
    const out = filt(s, `#< CLIXML\r\n${OBJS}\nreal-line\n`);
    assert(!out.includes('CLIXML') && !out.includes('<Objs'), 'complete envelope removed');
    assert(out.includes('real-line'), 'real text after envelope kept');
    assert(s.cliXmlCarry === '', 'no carry left after complete envelope');
  }

  // 2. Real lines first, then envelope -> envelope gone, reals intact.
  {
    const s = newSession();
    const out = filt(s, `line0\nline1\n#< CLIXML\r\n${OBJS}`);
    assert(out.includes('line0') && out.includes('line1'), 'preceding real lines kept');
    assert(!out.includes('<Objs') && !out.includes('CLIXML'), 'trailing envelope removed');
  }

  // 3. Cross-chunk <Objs> split across two chunks -> no leak.
  {
    const s = newSession();
    const head = '<Objs Version="1.1.0.1"><Obj S="progress"><T>par';
    const a = filt(s, `#< CLIXML\r\n${head}`);
    assert(!a.includes('<Objs'), 'chunk A holds incomplete <Objs in carry, emits nothing of it');
    assert(s.cliXmlCarry.startsWith('<Objs'), 'carry holds the open block');
    const b = filt(s, `tial</T></Obj></Objs>\nafter\n`);
    assert(!b.includes('<Objs') && !b.includes('par'), 'chunk B completes+drops block');
    assert(b.includes('after'), 'real text after split block kept');
    assert(s.cliXmlCarry === '', 'carry cleared after block close');
  }

  // 4. Cross-chunk header split (#< CL | IXML).
  {
    const s = newSession();
    const a = filt(s, 'before\n#< CL');
    assert(a.includes('before') && !a.includes('#< CL'), 'partial header carried, not emitted');
    assert(s.cliXmlCarry === '#< CL', 'header prefix in carry');
    const b = filt(s, `IXML\r\nreal\n`);
    assert(!b.includes('CLIXML') && b.includes('real'), 'completed header removed, real kept');
  }

  // 5. stripCliXml=false -> passthrough verbatim.
  {
    const s = newSession(false);
    const raw = `#< CLIXML\r\n${OBJS}\nx`;
    assert(filt(s, raw) === raw, 'non-PS session passes through unchanged');
  }

  // 6. Real content ending in '#' (mid-line) is NOT mistaken for a header.
  {
    const s = newSession();
    const out = filt(s, 'cost is 5#');
    assert(out === 'cost is 5#', "trailing '#' mid-line not carried");
    assert(s.cliXmlCarry === '', 'no false header carry');
  }

  if (failures > 0) { console.log(`${c.red}\n${failures} failed${c.reset}`); process.exit(1); }
  console.log(`${c.green}\nAll CLIXML filter tests passed${c.reset}`);
  process.exit(0);
}

run();
