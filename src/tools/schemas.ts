import { z } from "zod";

// Config tools schemas
export const GetConfigArgsSchema = z.object({});

export const SetConfigValueArgsSchema = z.object({
  key: z.string(),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.null(),
  ]),
  origin: z.enum(['ui', 'llm']).optional(),
});

// Empty schemas
export const ListProcessesArgsSchema = z.object({});

// Terminal tools schemas
export const StartProcessArgsSchema = z.object({
  command: z.string(),
  timeout_ms: z.number(),
  shell: z.string().optional(),
  verbose_timing: z.boolean().optional(),
  // Working directory for the spawned process. mcphub-style transports run
  // desktop-commander far from the user's IDE workspace, so commands without
  // an explicit cwd silently land in unexpected places. Resolution order
  // (high → low): args.cwd → config.defaultProcessCwd → env
  // DESKTOP_COMMANDER_DEFAULT_CWD → unset (inherits process cwd, legacy).
  // Path may use ~ (expanded to home) and may be relative (resolved against
  // process.cwd). Must point to an existing directory.
  cwd: z.string().optional(),
  // Per-call environment overrides. Merged on top of process.env so the
  // child sees inherited vars plus these. Cannot delete a parent-inherited
  // var (only set/override). Useful for one-off proxy / token / flag
  // injection without polluting the global env.
  env: z.record(z.string()).optional(),
});

export const ReadProcessOutputArgsSchema = z.object({
  pid: z.number(),
  timeout_ms: z.number().optional(),
  offset: z.number().optional(),   // Line offset: 0=from last read, positive=absolute, negative=tail
  length: z.number().optional(),   // Max lines to return (default from config.fileReadLineLimit)
  // tail -f style follow. When > 0, after computing the requested page the
  // tool blocks up to follow_ms waiting for NEW lines to be appended, then
  // returns as soon as any arrive (or the window elapses). Lets the model
  // watch a live-logging interactive process in bounded, paginated chunks
  // without busy-looping or flooding context. Typical use:
  //   read_process_output({ pid, offset: -50, follow_ms: 3000 })
  // = "show me the last 50 lines, then tail for up to 3s".
  follow_ms: z.number().optional(),
  verbose_timing: z.boolean().optional(),
});

// Per-line item for interact_with_process_lines. Objects only (NOT a
// string|object union) — zodToJsonSchema would emit anyOf for a union and
// some MCP clients (Cursor) reject anyOf in tool input schemas.
export const InteractWithProcessLineItemSchema = z.object({
  // The text to send for this step.
  input: z.string(),
  // Regex SOURCE string. After sending `input`, wait until the process's
  // newly-printed output ends with a match before sending the next line.
  // Overrides default_wait_for for this step. If neither is set, the built-in
  // prompt regex is used.
  wait_for: z.string().optional(),
  // Per-step wait cap (ms). Overrides default_timeout_ms for this step.
  timeout_ms: z.number().optional(),
  // Per-step newline behavior. Overrides default_append_newline.
  append_newline: z.boolean().optional(),
  // Escape hatch: instead of waiting for a prompt, just sleep this many ms
  // after sending (for processes whose prompt can't be regex-detected).
  delay_after_ms: z.number().optional(),
});

// interact_with_process_lines: expect/spawn-style sequential input.
// Sends each line and WAITS for the next prompt to actually appear before
// sending the following line — fixes the core failure of writing a multi-line
// blob to stdin all at once, where an async line-reader consumes newlines
// before its prompts have flushed and every subsequent line lands on the
// wrong prompt.
export const InteractWithProcessLinesArgsSchema = z.object({
  pid: z.number(),
  lines: z.array(InteractWithProcessLineItemSchema).min(1),
  // Default regex SOURCE used when a line has no own wait_for. Falsey ->
  // built-in prompt regex (`[:?>#$]\s*$|\)\s*$`).
  default_wait_for: z.string().optional(),
  // Default per-line wait cap (ms).
  default_timeout_ms: z.number().optional().default(5000),
  // Default newline behavior per line.
  default_append_newline: z.boolean().optional().default(true),
  // After a prompt match (or delay), sleep this long before sending the next
  // line so the process's stdout/stdin settle. Guards against racing a
  // not-yet-fully-flushed prompt.
  settle_ms: z.number().optional().default(40),
  // When true (default), stop at the first line whose wait times out and
  // return partial results instead of blindly feeding the rest.
  fail_fast: z.boolean().optional().default(true),
  // 'aggregated' (default): one combined output blob since the first send.
  // 'per_line': structured per-step output (heavier; truncated per step).
  collect_output: z.enum(['aggregated', 'per_line']).optional().default('aggregated'),
  verbose_timing: z.boolean().optional(),
});

export const ForceTerminateArgsSchema = z.object({
  pid: z.number(),
});

export const ListSessionsArgsSchema = z.object({});

export const KillProcessArgsSchema = z.object({
  pid: z.number(),
});

// Filesystem tools schemas
export const ReadFileArgsSchema = z.object({
  path: z.string(),
  isUrl: z.boolean().optional().default(false),
  offset: z.number().optional().default(0),
  length: z.number().optional().default(1000),
  sheet: z.string().optional(),  // String only for MCP client compatibility (Cursor doesn't support union types in JSON Schema)
  range: z.string().optional(),
  options: z.record(z.any()).optional()
});

export const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

export const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
  mode: z.enum(['rewrite', 'append']).default('rewrite'),
  // Overwrite protection: when mode='rewrite' and the target file already
  // exists, the handler refuses unless allowOverwrite is true. Prevents
  // silent full-file overwrites by AI clients that ignore prompt-level rules.
  // Disable globally via config: writeFileOverwriteProtection=false.
  allowOverwrite: z.boolean().optional().default(false),
});

// Batch write: create/append multiple files in ONE tool call. The real
// bottleneck for "AI scaffolds N files" is N MCP round-trips, not disk I/O
// (7MB writes in ~80ms). This collapses N round-trips to 1. Each entry runs
// through the same writeFile path (per-path mutex + auto-mkdir + overwrite
// protection); failures are reported per-file, not aborted as a batch
// (no cross-file filesystem transaction exists — pretending otherwise is
// more dangerous than honest partial success).
export const WriteMultipleFilesArgsSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    mode: z.enum(['rewrite', 'append']).optional().default('rewrite'),
    allowOverwrite: z.boolean().optional().default(false),
  })).min(1),
});

// PDF modification schemas - exported for reuse
export const PdfInsertOperationSchema = z.object({
  type: z.literal('insert'),
  pageIndex: z.number(),
  markdown: z.string().optional(),
  sourcePdfPath: z.string().optional(),
  pdfOptions: z.object({}).passthrough().optional(),
});

export const PdfDeleteOperationSchema = z.object({
  type: z.literal('delete'),
  pageIndexes: z.array(z.number()),
});

export const PdfOperationSchema = z.union([PdfInsertOperationSchema, PdfDeleteOperationSchema]);

export const WritePdfArgsSchema = z.object({
  path: z.string(),
  // Preprocess content to handle JSON strings that should be parsed as arrays
  content: z.preprocess(
    (val) => {
      // If it's a string that looks like JSON array, parse it
      if (typeof val === 'string' && val.trim().startsWith('[')) {
        try {
          return JSON.parse(val);
        } catch {
          // If parsing fails, return as-is (might be markdown content)
          return val;
        }
      }
      // Otherwise return as-is
      return val;
    },
    z.union([z.string(), z.array(PdfOperationSchema)])
  ),
  outputPath: z.string().optional(),
  options: z.object({}).passthrough().optional(), // Allow passing options to md-to-pdf
});

export const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

export const ListDirectoryArgsSchema = z.object({
  path: z.string(),
  depth: z.number().optional().default(2),
  // Pagination for large directories. Without this, listing a folder with
  // thousands of entries blows up host context windows (Kiro IDE notably
  // doesn't auto-truncate). Defaults match read_file pagination semantics.
  offset: z.number().optional().default(0),
  limit: z.number().optional(),  // Default applied at handler from config.responseMaxEntries
});

// Batch list multiple directories in one call. The list counterpart of
// read_multiple_files — one model turn instead of N list_directory calls.
export const ListMultipleDirectoriesArgsSchema = z.object({
  paths: z.array(z.string()).min(1),
  depth: z.number().optional().default(2),
});

export const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

export const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

// Pre-flight inspection of a file: lightweight stat + head/tail sample +
// binary / encoding / minified detection. Lets AI decide between
// read_file / list_directory / start_process WITHOUT first paying the cost
// of read_file on a 5MB minified blob or a binary asset.
export const InspectFileArgsSchema = z.object({
  path: z.string(),
});

// Edit tools schema - SIMPLIFIED from three modes to two
// Previously supported: text replacement, location-based edits (edits array), and range rewrites
// Now supports only: text replacement and range rewrites
// Removed 'edits' array parameter - location-based surgical edits were complex and unnecessary
// Range rewrites are more powerful and cover all structured file editing needs
export const EditBlockArgsSchema = z.object({
  file_path: z.string(),
  // Text file string replacement
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  expected_replacements: z.number().optional().default(1),
  // Structured file range rewrite (Excel, etc.)
  range: z.string().optional(),
  content: z.any().optional(),
  options: z.record(z.any()).optional()
}).refine(
  data => {
    // Helper to check if value is actually provided (not undefined, not empty string)
    const hasValue = (v: unknown) => v !== undefined && v !== '';
    return (hasValue(data.old_string) && data.new_string !== undefined) ||
           (hasValue(data.range) && hasValue(data.content));
  },
  { message: "Must provide either (old_string + new_string) or (range + content)" }
);

// Batch text edit across multiple files/positions in one call. The edit
// counterpart of write_multiple_files (batch create). Text search/replace
// only; for Excel/DOCX structured edits use edit_block per file.
export const EditBlockMultipleArgsSchema = z.object({
  edits: z.array(z.object({
    file_path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    expected_replacements: z.number().optional().default(1),
  })).min(1),
});

// Send input to process schema
export const InteractWithProcessArgsSchema = z.object({
  pid: z.number(),
  input: z.string(),
  timeout_ms: z.number().optional(),
  wait_for_prompt: z.boolean().optional(),
  verbose_timing: z.boolean().optional(),
  // When true (default) the input is followed by a newline, like pressing
  // Enter. Set false to send raw bytes — useful for: single-key menu pickers
  // ("y" / "n" / "1"), control characters ("\u0003" = Ctrl+C, "\u0004" = EOF),
  // or any prompt that reads one char without waiting for Enter.
  append_newline: z.boolean().optional().default(true),
  // Long-running mode. When true, do NOT report ✅ finished based on:
  //   (a) silence-based heuristics (no new output for X seconds)
  //   (b) the spawned shell's session being absent from the internal map
  // Many real long-runners (test suites, batch jobs, browser automation) go
  // silent for tens of seconds during sleeps/network waits and the spawned
  // shell can also exit before its grand-children (a Rust CLI that fork-execs
  // chrome.exe and continues using it). Treating those as "finished" makes
  // callers move on while work is still in-flight. With this flag set, the
  // tool will only report finished when an OS-level PID liveness check
  // (process.kill(pid, 0)) confirms the spawned shell PID is gone AND the
  // text-based isFinished heuristic fires — and even then it stays running
  // if the OS check disagrees. Default false preserves legacy fast-path.
  expect_long_running: z.boolean().optional().default(false),
});

// Usage stats schema
export const GetUsageStatsArgsSchema = z.object({});

// Feedback tool schema - no pre-filled parameters, all user input
export const GiveFeedbackArgsSchema = z.object({
  // No parameters needed - form will be filled manually by user
  // Only auto-filled hidden fields remain:
  // - tool_call_count (auto)
  // - days_using (auto) 
  // - platform (auto)
  // - client_id (auto)
});

// Search schemas (renamed for natural language)
export const StartSearchArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  searchType: z.enum(['files', 'content']).default('files'),
  filePattern: z.string().optional(),
  ignoreCase: z.boolean().optional().default(true),
  maxResults: z.number().optional(),
  includeHidden: z.boolean().optional().default(false),
  contextLines: z.number().optional().default(5),
  timeout_ms: z.number().optional(), // Match process naming convention
  earlyTermination: z.boolean().optional(), // Stop search early when exact filename match is found (default: true for files, false for content)
  literalSearch: z.boolean().optional().default(false), // Force literal string matching (-F flag) instead of regex
});

export const GetMoreSearchResultsArgsSchema = z.object({
  sessionId: z.string(),
  offset: z.number().optional().default(0),    // Same as file reading
  length: z.number().optional().default(100),  // Same as file reading (but smaller default)
});

export const StopSearchArgsSchema = z.object({
  sessionId: z.string(),
});

export const ListSearchesArgsSchema = z.object({});

// Prompts tool schema - SIMPLIFIED (only get_prompt action)
export const GetPromptsArgsSchema = z.object({
  action: z.enum(['get_prompt']),
  promptId: z.string(),
  // Disabled to check if it makes sense or should be removed or changed
  // anonymous_user_use_case: z.string().optional(),
});

// Tool history schema
export const GetRecentToolCallsArgsSchema = z.object({
  maxResults: z.number().min(1).max(1000).optional().default(50),
  toolName: z.string().optional(),
  since: z.string().datetime().optional(),
});

// Anomaly report schema. Read-only aggregator over the existing tool-call
// history JSONL. Designed for AIs to call once at session start so prior
// failure modes (cmd timeout trap, nested PS $var swallow, ERR_CWD,
// edit_block stale snapshot, etc.) surface automatically instead of the
// user needing to copy-paste them back to fix manually.
export const GetRecentAnomaliesArgsSchema = z.object({
  // Time window. 0 / undefined = all-time; positive integer = last N
  // minutes. Default 1440 = last 24h covers the typical "what went wrong
  // since yesterday" question without dragging in stale signal.
  since_minutes: z.number().int().min(0).max(60 * 24 * 30).optional().default(1440),
  // Minimum hit count for a rule to appear in the report. Default 1
  // (anything seen even once) — bump up for noisy long windows.
  min_count: z.number().int().min(1).optional().default(1),
  // Cap on number of distinct rules to return, ranked by hit count.
  top: z.number().int().min(1).max(50).optional().default(20),
});

export const TrackUiEventArgsSchema = z.object({
  event: z.string().min(1).max(80),
  component: z.string().optional().default('file_preview'),
  params: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().default({}),
});

/**
 * Map of tool name -> argument schema, used by the dispatcher to detect and warn
 * about parameters a caller sent that the tool does not support. Keep in sync
 * with the tool definitions in server.ts.
 */
export const toolArgSchemas: Record<string, z.ZodTypeAny> = {
  get_config: GetConfigArgsSchema,
  set_config_value: SetConfigValueArgsSchema,
  read_file: ReadFileArgsSchema,
  read_multiple_files: ReadMultipleFilesArgsSchema,
  write_file: WriteFileArgsSchema,
  write_multiple_files: WriteMultipleFilesArgsSchema,
  edit_block_multiple: EditBlockMultipleArgsSchema,
  write_pdf: WritePdfArgsSchema,
  create_directory: CreateDirectoryArgsSchema,
  list_directory: ListDirectoryArgsSchema,
  list_multiple_directories: ListMultipleDirectoriesArgsSchema,
  move_file: MoveFileArgsSchema,
  start_search: StartSearchArgsSchema,
  get_more_search_results: GetMoreSearchResultsArgsSchema,
  stop_search: StopSearchArgsSchema,
  list_searches: ListSearchesArgsSchema,
  get_file_info: GetFileInfoArgsSchema,
  inspect_file: InspectFileArgsSchema,
  edit_block: EditBlockArgsSchema,
  start_process: StartProcessArgsSchema,
  read_process_output: ReadProcessOutputArgsSchema,
  interact_with_process: InteractWithProcessArgsSchema,
  interact_with_process_lines: InteractWithProcessLinesArgsSchema,
  force_terminate: ForceTerminateArgsSchema,
  list_sessions: ListSessionsArgsSchema,
  list_processes: ListProcessesArgsSchema,
  kill_process: KillProcessArgsSchema,
  get_usage_stats: GetUsageStatsArgsSchema,
  get_recent_tool_calls: GetRecentToolCallsArgsSchema,
  get_recent_anomalies: GetRecentAnomaliesArgsSchema,
  give_feedback_to_desktop_commander: GiveFeedbackArgsSchema,
  get_prompts: GetPromptsArgsSchema,
  track_ui_event: TrackUiEventArgsSchema,
};
