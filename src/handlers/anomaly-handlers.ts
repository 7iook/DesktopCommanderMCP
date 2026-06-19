import { toolHistory } from '../utils/toolHistory.js';
import { aggregateAnomalies, formatAnomalyReport } from '../utils/anomaly-detector.js';
import { GetRecentAnomaliesArgsSchema } from '../tools/schemas.js';
import type { ServerResult } from '../types.js';

/**
 * handle_get_recent_anomalies
 *
 * Pulls the in-memory tool-call history and runs the anomaly rule set
 * against it to produce an aggregated, deduplicated report of known
 * anti-patterns and recurring failures. Designed to be called once at
 * the start of a new session (per global steering policy) so the AI
 * sees lessons from prior sessions without anyone needing to copy-paste
 * them back.
 *
 * Pure read path: does NOT mutate history, does NOT trigger persistence,
 * does NOT log itself into history (the EXCLUDED_TOOLS list in server.ts
 * keeps it out — same precedent as get_recent_tool_calls).
 */
export async function handleGetRecentAnomalies(args: unknown): Promise<ServerResult> {
  try {
    const parsed = GetRecentAnomaliesArgsSchema.parse(args);
    const sinceMinutes = parsed.since_minutes;
    const sinceMs = sinceMinutes && sinceMinutes > 0 ? sinceMinutes * 60_000 : undefined;

    // Pull a generous tail from history. toolHistory.getRecentCalls caps
    // at 1000 internally; we ask for the cap so the time-window filter
    // does the actual narrowing.
    const records = toolHistory.getRecentCalls({ maxResults: 1000 });

    const report = aggregateAnomalies(records, {
      sinceMs,
      minCount: parsed.min_count,
      topN: parsed.top,
    });

    const text = formatAnomalyReport(report);
    return {
      content: [{ type: 'text', text }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: get_recent_anomalies failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}
