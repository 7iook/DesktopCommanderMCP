/**
 * Tool-call anomaly detector.
 *
 * Reads ToolCallRecord entries (already collected by toolHistory.ts) and
 * runs a registered rule set against each to surface known anti-patterns
 * and recurring failure modes. Pure functions — no side effects, no I/O,
 * no hidden state. Detection is run on demand from the
 * `get_recent_anomalies` tool, NOT on every addCall (we don't want to
 * pay rule-evaluation cost on the hot path).
 *
 * Rules accumulate in this file as we ship fixes — every time we patch
 * a real-world AI mistake (cmd timeout trap, nested PS $var swallowing,
 * cwd-not-found, write_file overwrite, etc.), we add the matching
 * pattern here so the next AI hitting the same wall sees an aggregated
 * report instead of failing silently and you needing to copy-paste it
 * back to fix manually.
 */

import type { ToolCallRecord } from './toolHistory.js';

export type AnomalySeverity = 'info' | 'warn' | 'error';

export interface AnomalyHit {
  ruleId: string;
  ruleDescription: string;
  toolName: string;
  timestamp: string;          // ISO string from the original record
  severity: AnomalySeverity;
  /**
   * One-line context — usually a heavily truncated quotation of the
   * args (command, path) and/or output line that triggered the rule.
   * Kept short so aggregation reports don't blow up context windows.
   */
  context: string;
  suggestion: string;
}

interface Rule {
  id: string;
  description: string;
  severity: AnomalySeverity;
  /** If set, only consider records whose toolName is in this list. */
  appliesTo?: string[];
  suggestion: string;
  match: (record: ToolCallRecord) => string | null; // returns context string when matched
}

// Pull the text body of a ServerResult-shaped output without depending on
// types.ts (keeps this module self-contained).
function getOutputText(record: ToolCallRecord): string {
  const out = record.output as any;
  if (!out || !Array.isArray(out.content)) return '';
  let text = '';
  for (const item of out.content) {
    if (item && typeof item.text === 'string') text += item.text + '\n';
  }
  return text;
}

function isErrorResult(record: ToolCallRecord): boolean {
  const out = record.output as any;
  return !!(out && out.isError);
}

// Truncate a string to maxLen, replacing the middle with `...` if needed,
// and collapse newlines so context fits on one line in the report.
function truncate(s: string, maxLen = 140): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  const head = flat.slice(0, Math.floor(maxLen * 0.6));
  const tail = flat.slice(-Math.floor(maxLen * 0.3));
  return `${head} ... ${tail}`;
}

// =================== Rule definitions ===================

const RULES: Rule[] = [
  {
    id: 'cmd_timeout_trap',
    description: 'cmd `timeout /t N` cannot wait under desktop-commander stdio shell',
    severity: 'warn',
    appliesTo: ['start_process'],
    suggestion: 'Use PowerShell `Start-Sleep -Seconds N` (no console handle needed)',
    match: (r) => {
      const cmd = (r.arguments as any)?.command ?? '';
      const out = getOutputText(r);
      const cmdHit = /\btimeout(?:\.exe)?\s+\/t\s+\d+/i.test(cmd);
      const outHit = /Input redirection is not supported/i.test(out);
      if (cmdHit || outHit) return truncate(cmd || out, 140);
      return null;
    },
  },
  {
    id: 'ps_nested_var_swallowed',
    description: 'Nested `powershell -Command "..."` with $variable — outer shell expands $_ before inner sees it',
    severity: 'warn',
    appliesTo: ['start_process'],
    suggestion: 'Drop the wrapper: write the PowerShell expression directly, no outer powershell -Command',
    match: (r) => {
      const cmd = (r.arguments as any)?.command ?? '';
      const NESTED = /^\s*(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*-c(?:ommand)?\s+"/i;
      const HAS_VAR = /\$[_\w:]/;
      if (NESTED.test(cmd) && HAS_VAR.test(cmd)) return truncate(cmd, 140);
      return null;
    },
  },
  {
    id: 'cwd_not_found',
    description: 'start_process called with cwd that does not exist or is not a directory',
    severity: 'warn',
    appliesTo: ['start_process'],
    suggestion: 'Pass an absolute path that exists; mcphub default cwd is E:\\MCP\\mcphub, not your project root',
    match: (r) => {
      const out = getOutputText(r);
      if (/ERR_CWD_NOT_FOUND|ERR_CWD_NOT_DIR/.test(out)) {
        const cwd = (r.arguments as any)?.cwd ?? '';
        return truncate(`cwd=${cwd} | err: ${out.split('\n').find(l => /ERR_CWD/.test(l)) ?? out}`, 160);
      }
      return null;
    },
  },
  {
    id: 'write_file_overwrite_blocked',
    description: 'write_file rewrite of an existing file rejected by overwrite-protection',
    severity: 'info',
    appliesTo: ['write_file', 'write_multiple_files'],
    suggestion: 'Use edit_block for surgical changes, or pass mode:"append", or explicitly allowOverwrite:true if rewrite is intentional',
    match: (r) => {
      const out = getOutputText(r);
      if (/writeFileOverwriteProtection|refus(?:e|ing) to overwrite|allowOverwrite/i.test(out)) {
        const p = (r.arguments as any)?.path ?? '';
        return truncate(`path=${p} | ${out.split('\n')[0] ?? ''}`, 160);
      }
      return null;
    },
  },
  {
    id: 'edit_block_no_match',
    description: 'edit_block old_string did not match — typically a stale snapshot or whitespace mismatch',
    severity: 'info',
    appliesTo: ['edit_block'],
    suggestion: 'Re-read the file before editing; copy old_string from the actual current content (whitespace-exact)',
    match: (r) => {
      if (!isErrorResult(r)) return null;
      const out = getOutputText(r);
      if (/did not match|no match found|Closest match|expected_replacements/i.test(out)) {
        const p = (r.arguments as any)?.file_path ?? '';
        return truncate(`file=${p} | ${out.split('\n')[0] ?? ''}`, 160);
      }
      return null;
    },
  },
  {
    id: 'read_file_minified_blob',
    description: 'read_file hit a minified file (size > 10KB, ≤2 lines) — line-based reading useless',
    severity: 'info',
    appliesTo: ['read_file'],
    suggestion: 'Use start_process with jq/python/node to query the structure; do not pull the whole blob into context',
    match: (r) => {
      const out = getOutputText(r);
      if (/Likely minified|minified blob|isLikelyMinified/i.test(out)) {
        const p = (r.arguments as any)?.path ?? '';
        return truncate(`path=${p}`, 140);
      }
      return null;
    },
  },
  {
    id: 'command_blocked',
    description: 'Command rejected by command-manager block list',
    severity: 'warn',
    appliesTo: ['start_process'],
    suggestion: 'If the command is genuinely needed, update the allow/block list via set_config_value; do not retry verbatim',
    match: (r) => {
      const out = getOutputText(r);
      if (/Command not allowed|blockedCommands|is blocked/i.test(out)) {
        const cmd = (r.arguments as any)?.command ?? '';
        return truncate(`command=${cmd}`, 140);
      }
      return null;
    },
  },
  {
    id: 'interact_input_send_failed',
    description: 'interact_with_process could not deliver input — process exited or has no stdin',
    severity: 'warn',
    appliesTo: ['interact_with_process'],
    suggestion: 'Check the target PID with list_sessions first; long-running batch jobs benefit from expect_long_running:true',
    match: (r) => {
      const out = getOutputText(r);
      if (/Failed to send input|process may have exited|doesn.t accept input/i.test(out)) {
        const pid = (r.arguments as any)?.pid ?? '?';
        return truncate(`pid=${pid} | ${out.split('\n')[0] ?? ''}`, 160);
      }
      return null;
    },
  },
  {
    id: 'tool_isError',
    description: 'Tool call returned isError:true — fallback bucket for unclassified failures',
    severity: 'error',
    suggestion: 'Read the actual error text rather than retrying; if it recurs, add a dedicated rule here',
    // Lowest-priority generic rule. Runs LAST so specific rules above own
    // their hits first; this one only fires for errors no specific rule
    // matched. Implemented via skipIfMatched in detect().
    match: (r) => {
      if (!isErrorResult(r)) return null;
      const out = getOutputText(r);
      const firstLine = out.split('\n').find(l => l.trim().length > 0) ?? '';
      return truncate(`${r.toolName} | ${firstLine}`, 160);
    },
  },
];

// =================== Public API ===================

/**
 * Run all registered rules against a single ToolCallRecord and return
 * every rule that matched. Returns [] when none match.
 *
 * The generic `tool_isError` fallback rule is suppressed when any
 * specific rule already matched the same record — otherwise every
 * specific failure would also be re-counted as a generic error.
 */
export function detectAnomalies(record: ToolCallRecord): AnomalyHit[] {
  if (!record || !record.toolName) return [];
  const hits: AnomalyHit[] = [];
  let specificMatched = false;

  for (const rule of RULES) {
    if (rule.appliesTo && !rule.appliesTo.includes(record.toolName)) continue;
    if (rule.id === 'tool_isError' && specificMatched) continue;

    let context: string | null = null;
    try {
      context = rule.match(record);
    } catch {
      continue; // a buggy rule must never break detection
    }
    if (!context) continue;

    if (rule.id !== 'tool_isError') specificMatched = true;
    hits.push({
      ruleId: rule.id,
      ruleDescription: rule.description,
      toolName: record.toolName,
      timestamp: record.timestamp,
      severity: rule.severity,
      context,
      suggestion: rule.suggestion,
    });
  }
  return hits;
}

export interface AggregatedAnomaly {
  ruleId: string;
  ruleDescription: string;
  severity: AnomalySeverity;
  count: number;
  lastHit: string;        // ISO of most recent hit
  firstHit: string;
  suggestion: string;
  samples: AnomalyHit[];  // up to 3 most recent
}

export interface AnomalyReport {
  totalRecordsScanned: number;
  totalHits: number;
  windowStart?: string;   // ISO; undefined when no since filter
  windowEnd: string;      // ISO of newest record scanned (or now if empty)
  rules: AggregatedAnomaly[];
}

/**
 * Aggregate anomalies across many records, grouped by ruleId. Newest
 * records are scanned last so `lastHit` reflects the most recent
 * occurrence and `samples` keeps the latest exemplars.
 */
export function aggregateAnomalies(
  records: ToolCallRecord[],
  options: { sinceMs?: number; minCount?: number; topN?: number } = {}
): AnomalyReport {
  const sinceMs = options.sinceMs;
  const minCount = options.minCount ?? 1;
  const topN = options.topN ?? 20;
  const cutoff = sinceMs ? Date.now() - sinceMs : undefined;

  const filtered: ToolCallRecord[] = [];
  for (const r of records) {
    if (cutoff !== undefined) {
      const t = Date.parse(r.timestamp);
      if (Number.isFinite(t) && t < cutoff) continue;
    }
    filtered.push(r);
  }

  const byRule = new Map<string, AggregatedAnomaly>();
  for (const r of filtered) {
    const hits = detectAnomalies(r);
    for (const h of hits) {
      let agg = byRule.get(h.ruleId);
      if (!agg) {
        agg = {
          ruleId: h.ruleId,
          ruleDescription: h.ruleDescription,
          severity: h.severity,
          count: 0,
          lastHit: h.timestamp,
          firstHit: h.timestamp,
          suggestion: h.suggestion,
          samples: [],
        };
        byRule.set(h.ruleId, agg);
      }
      agg.count += 1;
      // Keep up-to-date last/first
      if (h.timestamp > agg.lastHit) agg.lastHit = h.timestamp;
      if (h.timestamp < agg.firstHit) agg.firstHit = h.timestamp;
      // Keep only 3 most recent samples
      agg.samples.push(h);
      if (agg.samples.length > 3) {
        agg.samples.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
        agg.samples.length = 3;
      }
    }
  }

  const rules = Array.from(byRule.values())
    .filter(a => a.count >= minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  return {
    totalRecordsScanned: filtered.length,
    totalHits: rules.reduce((s, a) => s + a.count, 0),
    windowStart: cutoff !== undefined ? new Date(cutoff).toISOString() : undefined,
    windowEnd: new Date().toISOString(),
    rules,
  };
}

/**
 * Render an AnomalyReport as a compact human/AI-readable text block.
 * Designed to fit in ~30-60 lines for a typical 24h window so it can be
 * pulled into a session-opener prompt without blowing up context.
 */
export function formatAnomalyReport(report: AnomalyReport): string {
  if (report.rules.length === 0) {
    const window = report.windowStart
      ? `since ${report.windowStart}`
      : 'all-time';
    return `🔎 Tool-call anomalies (${window}): none. ${report.totalRecordsScanned} records scanned.`;
  }

  const lines: string[] = [];
  const window = report.windowStart
    ? `since ${report.windowStart}`
    : 'all-time';
  lines.push(`🔎 Tool-call anomalies (${window}) — scanned ${report.totalRecordsScanned} records, ${report.totalHits} hits across ${report.rules.length} rules:`);
  lines.push('');

  let n = 1;
  for (const a of report.rules) {
    const sevIcon = a.severity === 'error' ? '❌' : a.severity === 'warn' ? '⚠️' : 'ℹ️';
    lines.push(`${n}. ${sevIcon} ${a.ruleId}  [${a.count} hit${a.count === 1 ? '' : 's'}, last ${a.lastHit}]`);
    lines.push(`   ${a.ruleDescription}`);
    lines.push(`   Suggestion: ${a.suggestion}`);
    if (a.samples.length > 0) {
      lines.push(`   Sample: ${a.samples[0].context}`);
    }
    lines.push('');
    n++;
  }

  return lines.join('\n').trimEnd();
}
