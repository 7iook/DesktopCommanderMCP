/**
 * PowerShell CLIXML decoding and Windows shell byte decoding.
 *
 * Two problems live together here because they arrive on the same bytes.
 *
 * 1. CLIXML record RECOVERY. When PowerShell's stdin is redirected it wraps
 *    its non-stdout streams in a `#< CLIXML` / `<Objs>...</Objs>` envelope,
 *    even with `-OutputFormat Text`. That envelope carries BOTH throwaway
 *    progress records AND the actual error text:
 *
 *      <Obj S="progress">...Preparing modules...</Obj>   <- noise, drop
 *      <S S="Error">foo : is not recognized...</S>       <- the real error
 *
 *    Deleting the whole envelope (the previous behavior) therefore destroyed
 *    every message written to PowerShell's error/warning/information streams:
 *    a failing command produced literally zero captured output. `extractClixmlRecords`
 *    keeps the records that carry text and drops only the noise.
 *
 * 2. ENCODING. The CLIXML payload is encoded with the console's OEM code page
 *    (936/950/932/...), NOT UTF-8, and no amount of `[Console]::OutputEncoding`
 *    patching changes that — PowerShell initializes its CLIXML writer before
 *    any user command runs. cmd.exe has the same problem for its own messages.
 *    So bytes must be sniffed, not assumed: `ShellByteDecoder` decodes strict
 *    UTF-8 when the bytes are valid UTF-8 and falls back to the OEM code page
 *    when they are not.
 *
 * Sniffing is reliable in this direction because UTF-8 is a self-validating
 * encoding: legacy DBCS text (GBK/Big5/SJIS) essentially never forms valid
 * UTF-8, while real UTF-8 always does. The risk is only at chunk boundaries,
 * which is what the carry logic below exists to handle.
 */

import { execFileSync } from 'child_process';

/**
 * Windows code page -> WHATWG encoding label understood by TextDecoder.
 *
 * Only the OEM/ANSI pages that actually ship as a Windows default are listed.
 * Single-byte OEM pages with no WHATWG equivalent (437, 850, 852, ...) map to
 * windows-1252: wrong for box-drawing glyphs, right for the Latin letters and
 * punctuation that appear in error messages, and never throws.
 */
const CODEPAGE_LABELS: Record<string, string> = {
  '65001': 'utf-8',
  '936': 'gbk',          // Simplified Chinese
  '950': 'big5',         // Traditional Chinese
  '932': 'shift_jis',    // Japanese
  '949': 'euc-kr',       // Korean
  '1250': 'windows-1250',
  '1251': 'windows-1251',
  '1252': 'windows-1252',
  '1253': 'windows-1253',
  '1254': 'windows-1254',
  '1255': 'windows-1255',
  '1256': 'windows-1256',
  '1257': 'windows-1257',
  '1258': 'windows-1258',
  '866': 'ibm866',
  '874': 'windows-874',
};

let cachedOemLabel: string | null | undefined;

/**
 * The OEM code page as a TextDecoder label, or null when it can't be
 * determined (non-Windows, registry unreadable, unmapped page).
 *
 * Read from the registry rather than `chcp`, because `chcp` reports the code
 * page of the *console this process owns* — for an MCP server launched by a
 * host that already set UTF-8, chcp says 65001 while cmd.exe still emits its
 * own messages in 936. The registry value is what the child actually uses.
 *
 * Cached: the lookup spawns `reg` once per server lifetime, lazily, on the
 * first shell session that needs it.
 */
export function resolveOemLabel(): string | null {
  if (cachedOemLabel !== undefined) return cachedOemLabel;
  cachedOemLabel = null;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'],
        { encoding: 'latin1', windowsHide: true, timeout: 5000 }
      );
      const cp = out.trim().split(/\s+/).pop();
      if (cp && CODEPAGE_LABELS[cp]) cachedOemLabel = CODEPAGE_LABELS[cp];
    } catch {
      // Leave null — callers fall back to lossy UTF-8, i.e. prior behavior.
    }
  }
  return cachedOemLabel;
}

/** Reset the cached OEM lookup. Test seam only. */
export function __resetOemLabelCache(): void {
  cachedOemLabel = undefined;
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function decodeWith(buf: Buffer, label: string | null): string {
  if (!label || label === 'utf-8') return buf.toString('utf8');
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * Decode a complete byte sequence from a Windows shell: strict UTF-8 when
 * valid, otherwise the OEM code page.
 *
 * `oemLabel` is injectable so tests are machine-independent; production callers
 * omit it and get `resolveOemLabel()`.
 */
export function decodeShellBytes(buf: Buffer, oemLabel?: string | null): string {
  if (buf.length === 0) return '';
  if (isValidUtf8(buf)) return buf.toString('utf8');
  const label = oemLabel === undefined ? resolveOemLabel() : oemLabel;
  return decodeWith(buf, label);
}

/**
 * Length of an incomplete multi-byte sequence at the end of `buf`, i.e. bytes
 * that must be carried to the next chunk rather than decoded now.
 *
 * The encoding must be decided BEFORE measuring the tail, because the same
 * byte means different things in each: in `CE DE` (GBK "无") the 0xDE is a
 * trail byte completing the character, while in UTF-8 a 0xDE would be a lead
 * byte still waiting for its continuation. Measuring first and guessing after
 * treats complete GBK text as truncated and splits it mid-character.
 *
 * So: valid UTF-8 wins outright (nothing pending). Otherwise, if dropping a
 * short trailing run makes the rest valid UTF-8 and that run is a well-formed
 * UTF-8 prefix, it's a split UTF-8 character. Failing both, treat the bytes as
 * DBCS and walk the lead/trail pairs from the start to see whether the final
 * lead byte still needs its partner.
 *
 * Returns 0 when the buffer ends on a complete character; never more than 3.
 */
export function incompleteTailLength(buf: Buffer): number {
  const n = buf.length;
  if (n === 0) return 0;
  if (isValidUtf8(buf)) return 0;

  // Case 1: a UTF-8 character split by the chunk boundary. The prefix before
  // the split must itself be valid UTF-8, and the trailing run must be a
  // genuine incomplete UTF-8 sequence (lead byte + too few continuations).
  for (let k = 1; k <= Math.min(3, n); k++) {
    const tail = buf.subarray(n - k);
    const lead = tail[0];
    if (lead < 0xc0) continue;                       // not a lead byte
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
    if (k >= need) continue;                         // would be complete, not a split
    let contigOk = true;
    for (let j = 1; j < k; j++) {
      if ((tail[j] & 0xc0) !== 0x80) { contigOk = false; break; }
    }
    if (!contigOk) continue;
    if (isValidUtf8(buf.subarray(0, n - k))) return k;
  }

  // Case 2: DBCS (GBK/Big5/SJIS). Walk pairs from the start so trail bytes are
  // never mistaken for leads; carry 1 only if the last lead byte is unpaired.
  let i = 0;
  while (i < n) {
    if (buf[i] >= 0x81 && buf[i] <= 0xfe) {
      if (i + 1 >= n) return 1;                      // lead byte, trail not here yet
      i += 2;
    } else {
      i += 1;
    }
  }
  return 0;
}

/**
 * Chunk-safe decoder for one output stream of a Windows shell.
 *
 * `data` events split wherever the pipe happened to flush, which can land in
 * the middle of a multi-byte character. Decoding each chunk independently
 * (`data.toString()`) corrupts that character — and, worse for the sniffing
 * above, makes a valid-UTF-8 stream look invalid and flip to OEM for one chunk.
 * This buffers the incomplete tail until the rest of the character arrives.
 */
export class ShellByteDecoder {
  private carry: Buffer = Buffer.alloc(0);
  private readonly oemLabel: string | null | undefined;

  constructor(oemLabel?: string | null) {
    this.oemLabel = oemLabel;
  }

  write(chunk: Buffer): string {
    const buf = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const tail = incompleteTailLength(buf);
    if (tail >= buf.length) {
      this.carry = buf;
      return '';
    }
    this.carry = tail > 0 ? buf.subarray(buf.length - tail) : Buffer.alloc(0);
    const complete = tail > 0 ? buf.subarray(0, buf.length - tail) : buf;
    return decodeShellBytes(complete, this.oemLabel);
  }

  /** Decode whatever incomplete bytes remain, at stream end. */
  flush(): string {
    if (this.carry.length === 0) return '';
    const out = decodeShellBytes(this.carry, this.oemLabel);
    this.carry = Buffer.alloc(0);
    return out;
  }
}

/**
 * Undo CLIXML string encoding: `_xNNNN_` escapes and XML entities.
 *
 * PowerShell escapes characters that can't appear literally in XML text —
 * notably CR and LF as `_x000D_` / `_x000A_`, which is why recovered records
 * need this to become real lines instead of one run-on string.
 */
export function unescapeClixmlString(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');   // last, so "&amp;lt;" doesn't become "<"
}

/**
 * Streams whose records carry text a caller needs to see. `progress` is
 * excluded: it's the module-loading spinner that motivated stripping CLIXML in
 * the first place, and it has no diagnostic value.
 */
const KEPT_RECORD_STREAMS = new Set(['Error', 'Warning', 'Information', 'Verbose', 'Debug']);

/**
 * Pull the human-readable text out of a CLIXML fragment.
 *
 * Only top-level `<S S="...">` records are considered — the `<AV>` / `<T>`
 * fields nested inside `<Obj S="progress">` are deliberately left alone, which
 * is what keeps progress noise out without a second pass.
 */
export function extractClixmlRecords(xml: string): string {
  if (!xml.includes('<S S=')) return '';
  let out = '';
  const re = /<S\s+S="([A-Za-z]+)">([\s\S]*?)<\/S>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (!KEPT_RECORD_STREAMS.has(m[1])) continue;
    out += unescapeClixmlString(m[2]);
  }
  return out;
}
