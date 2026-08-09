import { toolHistory } from '../utils/toolHistory.js';
import { GetRecentToolCallsArgsSchema, TrackUiEventArgsSchema } from '../tools/schemas.js';
import { ServerResult } from '../types.js';
import { capture_ui_event } from '../utils/capture.js';
import { configManager } from '../config-manager.js';
import { applyReadFileCharCap } from '../utils/response-cap.js';

type TrackUiEventParams = Record<string, string | number | boolean | null>;

export function buildTrackUiEventCapturePayload(event: string, component: string, params: TrackUiEventParams): Record<string, string | number | boolean | null> {
  return {
    ...params,
    component,
    event
  };
}

/**
 * Handle get_recent_tool_calls command
 *
 * Same class of defect as the old uncapped read_multiple_files, one order of
 * magnitude worse: every record carries that call's FULL output, so asking for
 * 50 recent calls in a session that read big files replays every one of those
 * payloads back into context (measured: 1.39M chars from 30 records).
 *
 * Two layers, matching the rest of the server:
 *   1. Per-record output preview — history is for "what did I call, did it
 *      succeed", not for re-reading old payloads. Full text is still reachable
 *      by re-running the tool.
 *   2. Whole-response cap (responseMaxChars) as the last line of defense.
 */
const MAX_OUTPUT_PREVIEW_CHARS = 800;

/**
 * Shrink one history record's output to a preview. Keeps the shape (so the AI
 * can still tell success from error) and states the drop explicitly — a
 * silently shortened payload would read as "the tool returned little".
 */
function previewCallOutput(output: unknown): unknown {
  if (output === null || output === undefined) return output;
  const serialized = JSON.stringify(output);
  if (serialized === undefined || serialized.length <= MAX_OUTPUT_PREVIEW_CHARS) return output;

  const record = output as { content?: unknown; isError?: boolean };
  const preview: Record<string, unknown> = {
    _note: `output omitted (${serialized.length} chars) — history shows calls, not payloads; re-run the tool to get its content`,
  };
  if (typeof record.isError === 'boolean') preview.isError = record.isError;
  if (Array.isArray(record.content)) {
    const firstText = record.content.find(
      (c): c is { type: string; text: string } =>
        !!c && typeof c === 'object' && (c as { type?: string }).type === 'text' && typeof (c as { text?: unknown }).text === 'string'
    );
    preview.contentItems = record.content.length;
    if (firstText) preview.firstTextPreview = firstText.text.slice(0, MAX_OUTPUT_PREVIEW_CHARS);
  }
  return preview;
}

export async function handleGetRecentToolCalls(args: unknown): Promise<ServerResult> {
  try {
    const parsed = GetRecentToolCallsArgsSchema.parse(args);
    const config = await configManager.getConfig();
    const responseMaxChars = config.responseMaxChars ?? 50000;
    
    // Use formatted version with local timezone
    const calls = toolHistory.getRecentCallsFormatted({
      maxResults: parsed.maxResults,
      toolName: parsed.toolName,
      since: parsed.since
    });
    
    const stats = toolHistory.getStats();
    
    // Format the response (excluding file path per user request)
    const summary = `Tool Call History (${calls.length} results, ${stats.totalEntries} total in memory)`;
    const trimmedCalls = calls.map(call => ({ ...call, output: previewCallOutput(call.output) }));
    const historyJson = JSON.stringify(trimmedCalls, null, 2);
    const capped = applyReadFileCharCap(historyJson, Math.max(0, responseMaxChars - summary.length));
    
    return {
      content: [{
        type: "text",
        text: `${summary}\n\n${capped.text}`
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error getting tool history: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Handle track_ui_event command
 */
export async function handleTrackUiEvent(args: unknown): Promise<ServerResult> {
  try {
    const parsed = TrackUiEventArgsSchema.parse(args);

    await capture_ui_event('mcp_ui_event', buildTrackUiEventCapturePayload(parsed.event, parsed.component, parsed.params));

    return {
      content: [{
        type: "text",
        text: `Tracked UI event: ${parsed.event}`
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error tracking UI event: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}
