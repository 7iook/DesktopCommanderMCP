import { terminalManager, MAX_BUFFERED_OUTPUT_CHARS } from '../terminal-manager.js';
import { commandManager } from '../command-manager.js';
import { StartProcessArgsSchema, ReadProcessOutputArgsSchema, InteractWithProcessArgsSchema, InteractWithProcessLinesArgsSchema, ForceTerminateArgsSchema, ListSessionsArgsSchema } from './schemas.js';
import { capture } from "../utils/capture.js";
import { ServerResult } from '../types.js';
import { analyzeProcessState, cleanProcessOutput, formatProcessStateMessage, ProcessState } from '../utils/process-detection.js';
import { applyResponseCharCap } from '../utils/response-cap.js';
import * as os from 'os';
import { configManager } from '../config-manager.js';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory where the MCP is installed (for ES module imports)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mcpRoot = path.resolve(__dirname, '..', '..');

/**
 * Resolve a cwd hint to an absolute, existing directory path.
 *
 * Handles:
 *   - undefined / empty → returns undefined (caller falls through legacy behavior)
 *   - leading ~ / ~/ → expanded to os.homedir()
 *   - relative paths → resolved against process.cwd() (server's own cwd, which
 *     for mcphub-spawned servers is mcphub's cwd — that's the whole reason
 *     this parameter exists, so callers should normally pass absolute)
 *   - non-existent path → throws Error with ERR_CWD_NOT_FOUND prefix
 *   - exists but not a directory → throws Error with ERR_CWD_NOT_DIR prefix
 *
 * Returns the resolved absolute path on success.
 */
async function resolveProcessCwd(rawCwd: string | undefined): Promise<string | undefined> {
  if (!rawCwd) return undefined;
  let expanded = rawCwd;
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(process.cwd(), expanded);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`ERR_CWD_NOT_FOUND: Working directory does not exist: ${resolved}`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`ERR_CWD_NOT_DIR: Working directory is not a directory: ${resolved}`);
  }
  return resolved;
}

// Track virtual Node sessions (PIDs that are actually Node fallback sessions)
const virtualNodeSessions = new Map<number, { timeout_ms: number }>();
let virtualPidCounter = -1000; // Use negative PIDs for virtual sessions

/**
 * OS-level liveness check for a PID. Independent of desktop-commander's
 * internal session map.
 *
 * Why this exists: the fast-path in interactWithProcess used to assume
 * `terminalManager.getSession(pid) === undefined` means "process finished",
 * which is only true if the spawned shell's `'exit'` event fired correctly.
 * Real-world failures (Windows ConPTY edge cases, IPC handle weirdness, or
 * a shell that exits before its grand-child like a Rust CLI fork-execing
 * chrome.exe and continuing) caused that fast-path to misreport ✅ finished
 * while the user-visible work was still running, leaving callers to move
 * on prematurely.
 *
 * `process.kill(pid, 0)` doesn't actually send a signal — it just probes.
 *   - returns true (no throw): PID exists in the OS process table
 *   - throws ESRCH: PID is not in the table → confirmed dead
 *   - throws EPERM: PID exists but we lack permission → still alive
 *   - other throws: treat as alive (better to over-wait than to lie about finished)
 *
 * Caveat: OS recycles PIDs. Short-term (within a single tool call window)
 * recycling is vanishingly rare on modern systems, so this is acceptable
 * as a tie-breaker — not as a long-term identity check.
 */
function isPidAlive(pid: number): boolean {
  if (!pid || pid < 0) return false; // virtual / invalid
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err && err.code === 'ESRCH') return false;
    if (err && err.code === 'EPERM') return true;
    return true; // unknown — bias to "still alive" so we don't lie
  }
}

/**
 * Execute Node.js code via temp file (fallback when Python unavailable)
 * Creates temp .mjs file in MCP directory for ES module import access
 */
async function executeNodeCode(code: string, timeout_ms: number = 30000): Promise<ServerResult> {
  const tempFile = path.join(mcpRoot, `.mcp-exec-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);

  try {
    await fs.writeFile(tempFile, code, 'utf8');

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      const proc = spawn(process.execPath, [tempFile], {
        cwd: mcpRoot,
        timeout: timeout_ms,
        windowsHide: true  // Prevent visible console windows on Windows
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (exitCode) => {
        resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
      });

      proc.on('error', (err) => {
        resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1 });
      });
    });

    // Clean up temp file
    await fs.unlink(tempFile).catch(() => {});

    if (result.exitCode !== 0) {
      return {
        content: [{
          type: "text",
          text: `Execution failed (exit code ${result.exitCode}):\n${result.stderr}\n${result.stdout}`
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: result.stdout || '(no output)'
      }]
    };

  } catch (error) {
    // Clean up temp file on error
    await fs.unlink(tempFile).catch(() => {});

    return {
      content: [{
        type: "text",
        text: `Failed to execute Node.js code: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Start a new process (renamed from execute_command)
 * Includes early detection of process waiting for input
 */
export async function startProcess(args: unknown): Promise<ServerResult> {
  const parsed = StartProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_start_process_failed');
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for start_process: ${parsed.error}` }],
      isError: true,
    };
  }

  try {
    const commands = commandManager.extractCommands(parsed.data.command).join(', ');
    capture('server_start_process', {
      command: commandManager.getBaseCommand(parsed.data.command),
      commands: commands
    });
  } catch (error) {
    capture('server_start_process', {
      command: commandManager.getBaseCommand(parsed.data.command)
    });
  }

  const isAllowed = await commandManager.validateCommand(parsed.data.command);
  if (!isAllowed) {
    return {
      content: [{ type: "text", text: `Error: Command not allowed: ${parsed.data.command}` }],
      isError: true,
    };
  }

  // Batch-kill pattern hook: detect "kill by NAME" commands that would sweep
  // mcphub's stdio MCP servers as collateral (python.exe / node.exe / etc.).
  // Precise PID kills (taskkill /F /PID N, Stop-Process -Id N) are unaffected.
  const batchKillWarning = commandManager.checkBatchKillPattern(parsed.data.command);
  if (batchKillWarning) {
    return {
      content: [{ type: "text", text: batchKillWarning }],
      isError: true,
    };
  }

  const commandToRun = parsed.data.command;

  // Handle node:local - runs Node.js code directly on MCP server
  if (commandToRun.trim() === 'node:local') {
    const virtualPid = virtualPidCounter--;
    virtualNodeSessions.set(virtualPid, { timeout_ms: parsed.data.timeout_ms || 30000 });

    return {
      content: [{
        type: "text",
        text: `Node.js session started with PID ${virtualPid} (MCP server execution)

   IMPORTANT: Each interact_with_process call runs as a FRESH script.
   State is NOT preserved between calls. Include ALL code in ONE call:
   - imports, file reading, processing, and output together.

   Available libraries:
   - ExcelJS for Excel files: import ExcelJS from 'exceljs'
   - All Node.js built-ins: fs, path, http, crypto, etc.

🔄 Ready for code - send complete self-contained script via interact_with_process.`
      }],
    };
  }

  let shellUsed: string | undefined = parsed.data.shell;

  if (!shellUsed) {
    const config = await configManager.getConfig();
    if (config.defaultShell) {
      shellUsed = config.defaultShell;
    } else {
      const isWindows = os.platform() === 'win32';
      if (isWindows && process.env.COMSPEC) {
        shellUsed = process.env.COMSPEC;
      } else if (!isWindows && process.env.SHELL) {
        shellUsed = process.env.SHELL;
      } else {
        shellUsed = isWindows ? 'cmd.exe' : '/bin/sh';
      }
    }
  }

  // Resolve cwd with priority: args.cwd > config.defaultProcessCwd > env
  // DESKTOP_COMMANDER_DEFAULT_CWD > undefined (legacy: spawn inherits process
  // cwd). Failure returns a clear error response so AI knows the path was
  // wrong and doesn't blame the command itself.
  let resolvedCwd: string | undefined;
  try {
    const config = await configManager.getConfig();
    const cwdHint =
      parsed.data.cwd ??
      config.defaultProcessCwd ??
      process.env.DESKTOP_COMMANDER_DEFAULT_CWD ??
      undefined;
    resolvedCwd = await resolveProcessCwd(cwdHint);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  // === Pre-execution: detect & auto-rewrite `pwsh/powershell -Command "..."`
  // wrappers carrying $variables. The outer shell (PowerShell) expands
  // $_/$env:*/$var inside the double-quoted argument BEFORE the inner
  // powershell sees them — so `$_.Name` becomes `.Name` and inner fails.
  // We extract the inner script and run that directly. Match only DOUBLE-
  // quoted wrappers (single-quoted ones don't expand $_, false positive).
  // Conservative: if quoting is ambiguous (no clean closing `"`, or extra
  // tokens after), don't rewrite — just keep the hint.
  const PS_NESTED_WRAPPER = /^\s*(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*-c(?:ommand)?\s+"/i;
  // Auto-rewrite is only safe when the OUTER shell is already PowerShell —
  // stripping the wrapper would otherwise leave PS syntax for cmd/bash to
  // parse (`$env:X='1'` is meaningless to cmd → "syntax incorrect"). On
  // Windows the default shell is PowerShell, so unspecified shell is treated
  // as PS-friendly; cmd/bash/etc. fall through to hint-only mode.
  const shellBase = (shellUsed && typeof shellUsed === 'string')
    ? path.basename(shellUsed).toLowerCase().replace(/\.exe$/, '')
    : '';
  const outerIsPowerShell = !shellBase || shellBase === 'powershell' || shellBase === 'pwsh';
  let commandToRunEffective = commandToRun;
  let nestedHint = '';
  if (PS_NESTED_WRAPPER.test(commandToRun) && /\$[_\w:]/.test(commandToRun)) {
    const m = /^\s*(?:powershell|pwsh)(?:\.exe)?\s+((?:-\w+\s+)*)-c(?:ommand)?\s+"([\s\S]*)$/i.exec(commandToRun);
    let rewritten: string | null = null;
    if (m && outerIsPowerShell) {
      const body = m[2];
      // Walk for the closing `"`, respecting PS backtick escape and doubled-quote.
      let end = -1, trailing = '';
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '`') { i++; continue; }
        if (c === '"' && body[i + 1] === '"') { i++; continue; }
        if (c === '"') { end = i; trailing = body.slice(i + 1); break; }
      }
      if (end >= 0 && !trailing.trim() && body.slice(0, end).trim()) {
        rewritten = body.slice(0, end);
      }
    }
    if (rewritten) {
      commandToRunEffective = rewritten;
      nestedHint =
        `\n\nℹ️ Auto-rewritten: stripped nested \`pwsh/powershell -Command "..."\` wrapper containing $variables.\n` +
        `The outer shell would have expanded $_/$env:*/$var before the inner powershell saw them.\n` +
        `Your inner script ran directly in the PowerShell shell (same effect, no double-parse).\n` +
        `For next time, drop the wrapper yourself: just write the PS expression.\n`;
    } else {
      nestedHint =
        `\n\n⚠️ Anti-pattern HINT — your command DID execute as-is (auto-rewrite skipped, ambiguous quoting):\n` +
        `Nested \`pwsh/powershell -Command "..."\` wrapper containing $variables.\n` +
        `The OUTER shell expanded $_/$env:*/$var inside the double-quoted argument BEFORE\n` +
        `the inner powershell saw them — that's why $_.Name becomes .Name.\n` +
        `Fix: drop the wrapper. Bad: \`powershell -Command "Get-Process | %{$_.Name}"\`\n` +
        `Good: \`Get-Process | %{ $_.Name }\`\n`;
    }
  }

  const result = await terminalManager.executeCommand(
    commandToRunEffective,
    parsed.data.timeout_ms,
    shellUsed,
    parsed.data.verbose_timing || false,
    resolvedCwd,
    parsed.data.env
  );

  // Detect a recurring AI anti-pattern: `cmd /c timeout /t N`. timeout.exe
  // needs a real console handle that desktop-commander's piped stdio shell
  // does NOT provide; it bails out and any chained commands run with zero
  // wait — the sleep didn't happen. Only a hint; we don't rewrite.
  const CMD_TIMEOUT_TRAP = /\btimeout(?:\.exe)?\s+\/t\s+\d+/i;

  let antiPatternHint = nestedHint;
  if (CMD_TIMEOUT_TRAP.test(commandToRun)) {
    antiPatternHint +=
      `\n\n⚠️ Anti-pattern HINT — your command DID execute as-is, this is just guidance:\n` +
      `\`timeout /t N\` was detected. timeout.exe requires a real console handle that\n` +
      `desktop-commander's piped stdio shell does NOT provide. In this environment,\n` +
      `\`timeout /t N\` exits immediately with "Input redirection is not supported"\n` +
      `and any commands chained after it run with zero wait — your sleep didn't happen.\n` +
      `Use PowerShell \`Start-Sleep\` instead (no console handle needed):\n` +
      `  Bad:  cmd /c "timeout /t 90 /nobreak >nul & echo done"\n` +
      `  Good: powershell -NoProfile -Command "Start-Sleep -Seconds 90; Write-Output done"\n` +
      `(That is a nested powershell wrapper, but with NO $variable — the other anti-pattern\n` +
      `hint is scoped to nested-wrapper + $variable specifically and won't fire here.)\n`;
  }

  if (result.pid === -1) {
    return {
      content: [{ type: "text", text: result.output + antiPatternHint }],
      isError: true,
    };
  }

  // Analyze the process state to detect if it's waiting for input
  const processState = analyzeProcessState(result.output, result.pid);

  // OS-level liveness override — same root cause as the interact_with_process
  // fix in 80ee148/0298e12: analyzeProcessState's text heuristic flips
  // isFinished=true when output matches ERROR_COMPLETION_PATTERNS
  // (Error: / Exception: / Traceback / Node stack trace) or
  // COMPLETION_INDICATORS (Process finished / Exit code:). For long-running
  // processes that print an error early but keep running (Rust trial harness,
  // test suites with one failing worker, batch jobs) this would label the
  // session ✅ finished while the PID is still alive — the AI then moves on
  // to read logs / clean up and the work is left mid-flight. Verify against
  // the OS before trusting the text signal; if the OS says alive, downgrade
  // to "running" so the status line reflects ground truth.
  if (processState.isFinished && isPidAlive(result.pid)) {
    processState.isFinished = false;
    processState.isRunning = true;
  }

  // Symmetric OS-level override for the OPPOSITE mislabel: the text heuristic
  // says "waiting for input" but the PID is already dead. A dead process
  // cannot be blocked on stdin, so this is always a false positive (a prompt
  // char like `>` / `... ` left in the final output of a one-shot command).
  // Left uncorrected it produces the exact contradiction users hit: the tool
  // reports "waiting for input", the AI calls force_terminate, and gets
  // "No active session" because the process exited and its session already
  // moved to completedSessions. Trust the OS: not alive ⇒ finished.
  if (processState.isWaitingForInput && !isPidAlive(result.pid)) {
    processState.isWaitingForInput = false;
    processState.isFinished = true;
    processState.isRunning = false;
  }

  let statusMessage = '';
  if (processState.isWaitingForInput) {
    statusMessage = `\n🔄 ${formatProcessStateMessage(processState, result.pid)}`;
  } else if (processState.isFinished) {
    statusMessage = `\n✅ ${formatProcessStateMessage(processState, result.pid)}`;
  } else if (result.isBlocked) {
    statusMessage = '\n⏳ Process is running. Use read_process_output to get more output.';
  }

  // Add timing information if requested
  let timingMessage = '';
  if (result.timingInfo) {
    timingMessage = formatTimingInfo(result.timingInfo);
  }

  // Char-level cap on initial output. The per-session 50MB ring buffer keeps
  // the full stream — full output is reachable via read_process_output.
  // Without this cap, `ls -laR /` or similar floods the host context window.
  const config = await configManager.getConfig();
  const initialCap = config.initialOutputMaxChars ?? 16000;
  const cappedOutput = applyResponseCharCap(
    result.output,
    initialCap,
    `the EARLIER output was dropped (tail kept) but is fully retained in the buffer — read it with read_process_output(pid=${result.pid}, offset=0, length=N) and page forward with a positive line offset`
  );

  return {
    content: [{
      type: "text",
      text: `Process started with PID ${result.pid} (shell: ${shellUsed})\nInitial output:\n${cappedOutput}${statusMessage}${timingMessage}${antiPatternHint}`
    }],
  };
}

function formatTimingInfo(timing: any): string {
  let msg = '\n\n📊 Timing Information:\n';
  msg += `  Exit Reason: ${timing.exitReason}\n`;
  msg += `  Total Duration: ${timing.totalDurationMs}ms\n`;

  if (timing.timeToFirstOutputMs !== undefined) {
    msg += `  Time to First Output: ${timing.timeToFirstOutputMs}ms\n`;
  }

  if (timing.firstOutputTime && timing.lastOutputTime) {
    msg += `  Output Window: ${timing.lastOutputTime - timing.firstOutputTime}ms\n`;
  }

  if (timing.outputEvents && timing.outputEvents.length > 0) {
    msg += `\n  Output Events (${timing.outputEvents.length} total):\n`;
    timing.outputEvents.forEach((event: any, idx: number) => {
      msg += `    [${idx + 1}] +${event.deltaMs}ms | ${event.source} | ${event.length}b`;
      if (event.matchedPattern) {
        msg += ` | 🎯 ${event.matchedPattern}`;
      }
      msg += `\n       "${event.snippet}"\n`;
    });
  }

  return msg;
}

/**
 * Read output from a running process with file-like pagination
 * Supports offset/length parameters for controlled reading
 */
export async function readProcessOutput(args: unknown): Promise<ServerResult> {
  const parsed = ReadProcessOutputArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for read_process_output: ${parsed.error}` }],
      isError: true,
    };
  }

  // Get default line limit from config
  const config = await configManager.getConfig();
  const defaultLength = config.fileReadLineLimit ?? 1000;

  const { 
    pid, 
    timeout_ms = 5000, 
    offset = 0,                    // 0 = from last read, positive = absolute, negative = tail
    length = defaultLength,        // Default from config, same as file reading
    follow_ms,                     // tail -f window (ms); see schema
    verbose_timing = false 
  } = parsed.data;

  // Timing telemetry
  const startTime = Date.now();

  // For active sessions with no new output yet, optionally wait for output
  const session = terminalManager.getSession(pid);

  // tail -f follow for absolute/tail reads (offset !== 0). This waits for NEW
  // output to be appended, then falls through to the normal read below. For
  // offset === 0 the existing "new output" wait already covers this.
  //
  // Trigger on CHAR count, not line count: a process updating in place (`\r`
  // progress bars) or printing a partial line without a trailing newline never
  // bumps the line count, so the old line-based wait sat idle until the next
  // newline — looking like follow_ms was ignored. (Child-side block buffering
  // — a process whose libc fully buffers stdout to a pipe because it's not a
  // TTY, or output redirected away from the pipe entirely — is a separate
  // issue this cannot fix without a PTY, which this transport does not allocate.)
  //
  // A NEGATIVE offset stays a TRUE tail of the CURRENT buffer on every call
  // (per the documented contract: offset<0 = "last N lines now", offset=0 =
  // gapless cursor-based follow). We deliberately do NOT rebase it to an
  // absolute cursor here — doing so both breaks the "always tail" contract and
  // strands the read on the empty trailing line.
  if (session && follow_ms && follow_ms > 0 && offset !== 0) {
    const charBaseline = terminalManager.getOutputCharCount(pid) || 0;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearInterval(iv); clearTimeout(to); resolve(); };
      const iv = setInterval(() => {
        const now = terminalManager.getOutputCharCount(pid) || 0;
        if (now > charBaseline || !terminalManager.getSession(pid)) finish();
      }, 50);
      const to = setTimeout(finish, follow_ms);
    });
  }

  if (session && offset === 0) {
    // Wait for new output to arrive (only for "new output" reads, not absolute/tail)
    const effectiveWaitMs = (follow_ms && follow_ms > 0) ? follow_ms : timeout_ms;
    const waitForOutput = (): Promise<void> => {
      return new Promise((resolve) => {
        // Check if there's already new output
        const currentLines = terminalManager.getOutputLineCount(pid) || 0;
        if (currentLines > session.lastReadIndex) {
          resolve();
          return;
        }

        let resolved = false;
        let interval: NodeJS.Timeout | null = null;
        let timeout: NodeJS.Timeout | null = null;

        const cleanup = () => {
          if (interval) clearInterval(interval);
          if (timeout) clearTimeout(timeout);
        };

        const resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve();
        };

        // Poll for new output
        interval = setInterval(() => {
          const newLineCount = terminalManager.getOutputLineCount(pid) || 0;
          if (newLineCount > session.lastReadIndex) {
            resolveOnce();
          }
        }, 50);

        // Timeout
        timeout = setTimeout(() => {
          resolveOnce();
        }, effectiveWaitMs);
      });
    };

    await waitForOutput();
  }

  // Read output with pagination. offset<0 is a true tail of the current
  // buffer; offset=0 is cursor-based (advances lastReadIndex); offset>0 is
  // absolute. The trailing empty-line artifact is handled inside readOutputPaginated.
  const result = terminalManager.readOutputPaginated(pid, offset, length);
  
  if (!result) {
    return {
      content: [{ type: "text", text: `No session found for PID ${pid}` }],
      isError: true,
    };
  }

  // Join lines back into string
  const output = result.lines.join('\n');

  // Generate status message similar to file reading
  let statusMessage = '';
  if (offset < 0) {
    // Tail read - match file reading format for consistency
    statusMessage = `[Reading last ${result.readCount} lines (total: ${result.totalLines} lines)]`;
  } else if (offset === 0) {
    // "New output" read
    if (result.remaining > 0) {
      statusMessage = `[Reading ${result.readCount} new lines from line ${result.readFrom} (total: ${result.totalLines} lines, ${result.remaining} remaining)]`;
    } else {
      statusMessage = `[Reading ${result.readCount} new lines (total: ${result.totalLines} lines)]`;
    }
  } else {
    // Absolute position read
    statusMessage = `[Reading ${result.readCount} lines from line ${result.readFrom} (total: ${result.totalLines} lines, ${result.remaining} remaining)]`;
  }

  // Surface buffer-cap eviction so the model knows the retained output is not
  // the full output and that line numbers shifted (matches the truncation
  // markers used by other tools).
  if (result.evictedLines && result.evictedLines > 0) {
    const capMB = Math.round(MAX_BUFFERED_OUTPUT_CHARS / 1024 / 1024);
    statusMessage += `\n[WARNING: output exceeded the ${capMB}MB buffer cap; the ${result.evictedLines} earliest lines were evicted and cannot be read. Line numbers and totals refer to the retained buffer only]`;
  }

  // Add process state info
  let processStateMessage = '';
  if (result.isComplete) {
    const runtimeStr = result.runtimeMs !== undefined 
      ? ` (runtime: ${(result.runtimeMs / 1000).toFixed(2)}s)` 
      : '';
    processStateMessage = `\n✅ Process completed with exit code ${result.exitCode}${runtimeStr}`;
  } else if (session) {
    // Analyze state for running processes
    const fullOutput = session.outputLines.join('\n');
    const processState = analyzeProcessState(fullOutput, pid);
    if (processState.isWaitingForInput) {
      processStateMessage = `\n🔄 ${formatProcessStateMessage(processState, pid)}`;
    }
  }

  // Add timing information if requested
  let timingMessage = '';
  if (verbose_timing) {
    const endTime = Date.now();
    timingMessage = `\n\n📊 Timing: ${endTime - startTime}ms`;
  }

  const responseText = output || '(No output in requested range)';

  // A failed command with zero captured output is the single most misleading
  // result this tool can return: "(No output in requested range)" reads like a
  // paging mistake, so the caller re-reads with different offsets, then starts
  // re-running the command with its output teed to a file to find out what
  // actually happened. Name the situation instead, and point at the causes that
  // actually produce it — output written straight to a console handle (see the
  // AllocConsole class of failures), a GUI/detached child, or output that only
  // exists on a stream this shell didn't pipe back.
  let emptyOutputHint = '';
  if (result.isComplete && result.totalLines === 0 && result.exitCode !== 0) {
    emptyOutputHint =
      `\n\n⚠️ This process FAILED (exit code ${result.exitCode}) and produced NO capturable output.\n` +
      `This is not a paging problem — re-reading with a different offset will not help.\n` +
      `Likely causes, in order: the program wrote to a console handle instead of the\n` +
      `redirected pipe (common for nested shells / GUI-spawning tools), or it only wrote\n` +
      `to a stream this shell did not pipe back.\n` +
      `Next steps: re-run with \`2>&1\` to merge stderr into stdout, add the tool's own\n` +
      `verbose/log flag, or redirect to a file and read that file.`;
  }

  // Char-level cap so a long-line process (every line > 1KB) can't blow up
  // the host context. Line-level pagination above bounds line count, but
  // doesn't bound chars-per-line; this is the second guard.
  const responseMaxChars = config.responseMaxChars ?? 50000;
  const cappedResponse = applyResponseCharCap(
    responseText,
    responseMaxChars,
    `this page's earlier chars were dropped (tail kept); the lines are still in the buffer — re-read this range with a smaller length, or address it directly via read_process_output(pid=${pid}, offset=${result.readFrom}, length=N)`
  );

  return {
    content: [{
      type: "text",
      text: `${statusMessage}\n\n${cappedResponse}${processStateMessage}${emptyOutputHint}${timingMessage}`
    }],
  };
}

/**
 * Interact with a running process (renamed from send_input)
 * Automatically detects when process is ready and returns output
 */
export async function interactWithProcess(args: unknown): Promise<ServerResult> {
  const parsed = InteractWithProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_interact_with_process_failed', {
      error: 'Invalid arguments'
    });
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for interact_with_process: ${parsed.error}` }],
      isError: true,
    };
  }

  const {
    pid,
    input,
    timeout_ms = 8000,
    wait_for_prompt = true,
    verbose_timing = false,
    append_newline = true,
    expect_long_running = false
  } = parsed.data;

  // Get config for output line limit
  const config = await configManager.getConfig();
  const maxOutputLines = config.fileReadLineLimit ?? 1000;

  // Check if this is a virtual Node session (node:local)
  if (virtualNodeSessions.has(pid)) {
    const session = virtualNodeSessions.get(pid)!;
    capture('server_interact_with_process_node_fallback', {
      pid: pid,
      inputLength: input.length
    });

    // Execute code via temp file approach
    // Respect per-call timeout if provided, otherwise use session default
    const effectiveTimeout = timeout_ms ?? session.timeout_ms;
    return executeNodeCode(input, effectiveTimeout);
  }

  // Timing telemetry
  const startTime = Date.now();
  let firstOutputTime: number | undefined;
  let lastOutputTime: number | undefined;
  const outputEvents: any[] = [];
  let exitReason: 'early_exit_quick_pattern' | 'early_exit_periodic_check' | 'process_finished' | 'timeout' | 'no_wait' = 'timeout';

  try {
    capture('server_interact_with_process', {
      pid: pid,
      inputLength: input.length
    });

    // Capture output snapshot BEFORE sending input
    // This handles REPLs where output is appended to the prompt line
    const outputSnapshot = terminalManager.captureOutputSnapshot(pid);

    const success = terminalManager.sendInputToProcess(pid, input, append_newline);

    if (!success) {
      return {
        content: [{ type: "text", text: `Error: Failed to send input to process ${pid}. The process may have exited or doesn't accept input.` }],
        isError: true,
      };
    }

    // If not waiting for response, return immediately
    if (!wait_for_prompt) {
      exitReason = 'no_wait';
      let timingMessage = '';
      if (verbose_timing) {
        const endTime = Date.now();
        const timingInfo = {
          startTime,
          endTime,
          totalDurationMs: endTime - startTime,
          exitReason,
          firstOutputTime,
          lastOutputTime,
          timeToFirstOutputMs: undefined,
          outputEvents: undefined
        };
        timingMessage = formatTimingInfo(timingInfo);
      }
      return {
        content: [{
          type: "text",
          text: `✅ Input sent to process ${pid}. Use read_process_output to get the response.${timingMessage}`
        }],
      };
    }

    // Smart waiting with immediate and periodic detection
    let output = "";
    let processState: ProcessState | undefined;
    let earlyExit = false;

    // Quick prompt patterns for immediate detection
    const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;
    
    const waitForResponse = (): Promise<void> => {
      return new Promise((resolve) => {
        let resolved = false;
        let attempts = 0;
        const pollIntervalMs = 50; // Poll every 50ms for faster response
        const maxAttempts = Math.ceil(timeout_ms / pollIntervalMs);
        let interval: NodeJS.Timeout | null = null;
        let lastOutputLength = 0; // Track output length to detect new output

        let resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          if (interval) clearInterval(interval);
          resolve();
        };

        // Fast-polling check - check every 50ms for quick responses
        interval = setInterval(() => {
          if (resolved) return;

          // FAST PATH: process exited between polls — flush any final output
          // and resolve immediately. Without this, a command that prints
          // "done." then exits sits in the loop until timeout_ms because
          // analyzeProcessState's text-based isFinished heuristic doesn't
          // know about real process lifecycle.
          //
          // BUT: the internal session map being empty is only a *first*
          // signal — desktop-commander's `'exit'` listener fires for the
          // *spawned shell*, not for grand-children. A Rust CLI that
          // fork-execs chrome.exe (and keeps using it) can leave the shell
          // dead but the real work running, and Windows ConPTY edge cases
          // can fire 'exit' even earlier. Verify with an OS-level PID
          // liveness check before claiming finished. If the OS says the
          // PID is still alive, we trust the OS over the stale Map and
          // continue polling instead of misreporting ✅ finished.
          if (!terminalManager.getSession(pid)) {
            const stillAlive = isPidAlive(pid);
            if (stillAlive) {
              // Map is stale; flush whatever output we have and keep waiting.
              // Don't synthesize isFinished — the next poll iteration handles
              // detection normally.
              const flushAlive = outputSnapshot
                ? terminalManager.getOutputSinceSnapshot(pid, outputSnapshot)
                : terminalManager.getNewOutput(pid);
              if (flushAlive && flushAlive.length > lastOutputLength) {
                output = flushAlive;
                lastOutputLength = flushAlive.length;
              }
              // Fall through to the normal new-output / prompt detection below.
            } else {
              // OS confirms PID is gone (ESRCH) — finished for real.
              const flush = outputSnapshot
                ? terminalManager.getOutputSinceSnapshot(pid, outputSnapshot)
                : terminalManager.getNewOutput(pid);
              if (flush && flush.length > lastOutputLength) {
                output = flush;
                lastOutputLength = flush.length;
              }
              // Mark as a clean early exit so the downstream summary doesn't
              // tag this as "Response may be incomplete (timeout reached)".
              earlyExit = true;
              exitReason = 'process_finished';
              // Synthesize an isFinished state so the post-loop summary picks
              // the ✅ "Process N has finished execution" branch.
              processState = analyzeProcessState(output, pid);
              processState.isFinished = true;
              processState.isWaitingForInput = false;
              processState.isRunning = false;
              resolveOnce();
              return;
            }
          }

          // Use snapshot-based reading to handle REPL prompt line appending
          const newOutput = outputSnapshot 
            ? terminalManager.getOutputSinceSnapshot(pid, outputSnapshot)
            : terminalManager.getNewOutput(pid);
            
          if (newOutput && newOutput.length > lastOutputLength) {
            const now = Date.now();
            if (!firstOutputTime) firstOutputTime = now;
            lastOutputTime = now;

            if (verbose_timing) {
              outputEvents.push({
                timestamp: now,
                deltaMs: now - startTime,
                source: 'periodic_poll',
                length: newOutput.length - lastOutputLength,
                snippet: newOutput.slice(lastOutputLength, lastOutputLength + 50).replace(/\n/g, '\\n')
              });
            }

            output = newOutput; // Replace with full output since snapshot
            lastOutputLength = newOutput.length;

            // Analyze current state
            processState = analyzeProcessState(output, pid);

            // Exit early if we detect the process is waiting for input
            if (processState.isWaitingForInput) {
              earlyExit = true;
              exitReason = 'early_exit_periodic_check';

              if (verbose_timing && outputEvents.length > 0) {
                outputEvents[outputEvents.length - 1].matchedPattern = 'periodic_check';
              }

              resolveOnce();
              return;
            }

            // Also exit if process finished. text-based isFinished is set by
            // analyzeProcessState when the output matches COMPLETION_INDICATORS
            // ("Process finished", "Exit code:", ...) or ERROR_COMPLETION_PATTERNS
            // ("Error:", "Exception:", "Traceback", a Node stack trace, ...).
            // In long batch jobs (test suites, browser automation, trial harnesses)
            // a single failing worker frequently prints stack traces while the
            // parent is still running — trusting that text alone made
            // interact_with_process say ✅ finished mid-batch and callers moved
            // on prematurely.
            //
            // OS-level liveness is the baseline defense, NOT a long-running
            // specialty: even default callers should not be lied to. We always
            // verify with isPidAlive() before honoring text-based isFinished.
            // expect_long_running is preserved as a stricter posture (e.g. OS
            // unknown / EPERM still treated as alive) but the default already
            // gets the OS sanity check — same root cause, two failure modes,
            // unified fix per the sweep-the-class principle.
            if (processState.isFinished) {
              if (isPidAlive(pid)) {
                // Text said done, but OS says PID is still alive. Treat the
                // text signal as a transient log line, not a real completion.
                // Drop back into the polling loop so we either pick up a real
                // prompt / actual finish later or hit timeout cleanly.
                processState.isFinished = false;
                processState.isRunning = true;
              } else {
                exitReason = 'process_finished';
                resolveOnce();
                return;
              }
            }
          }

          attempts++;
          if (attempts >= maxAttempts) {
            exitReason = 'timeout';
            resolveOnce();
          }
        }, pollIntervalMs);
      });
    };
    
    await waitForResponse();

    // Clean and format output
    let cleanOutput = cleanProcessOutput(output, input);
    const timeoutReached = !earlyExit && !processState?.isFinished && !processState?.isWaitingForInput;
    
    // Apply output line limit to prevent context overflow
    let truncationMessage = '';
    const outputLines = cleanOutput.split('\n');
    if (outputLines.length > maxOutputLines) {
      const truncatedLines = outputLines.slice(0, maxOutputLines);
      cleanOutput = truncatedLines.join('\n');
      const remainingLines = outputLines.length - maxOutputLines;
      truncationMessage = `\n\n⚠️ Output truncated: showing ${maxOutputLines} of ${outputLines.length} lines (${remainingLines} hidden). Use read_process_output with offset/length for full output.`;
    }

    // Char-level cap (second guard against long-line floods).
    const responseMaxChars = config.responseMaxChars ?? 50000;
    if (cleanOutput.length > responseMaxChars) {
      cleanOutput = applyResponseCharCap(
        cleanOutput,
        responseMaxChars,
        `the earlier output was dropped (tail kept) but is fully retained in the buffer — read it with read_process_output(pid=${pid}, offset=0, length=N) and page forward with a positive line offset`
      );
    }
    
    // Determine final state
    if (!processState) {
      processState = analyzeProcessState(output, pid);
    }
    
    let statusMessage = '';
    if (processState.isWaitingForInput) {
      statusMessage = `\n🔄 ${formatProcessStateMessage(processState, pid)}`;
    } else if (processState.isFinished) {
      statusMessage = `\n✅ ${formatProcessStateMessage(processState, pid)}`;
    } else if (timeoutReached) {
      // Still running and producing (or about to). Point the model at the
      // bounded tail-follow read instead of leaving it guessing — this is the
      // main reason callers miss live log output from long interactive runs.
      statusMessage = `\n⏱️ Response may be incomplete (timeout reached). Process ${pid} may still be running — use read_process_output(pid=${pid}, offset=-50, follow_ms=3000) to tail its live output.`;
    }

    // Add timing information if requested
    let timingMessage = '';
    if (verbose_timing) {
      const endTime = Date.now();
      const timingInfo = {
        startTime,
        endTime,
        totalDurationMs: endTime - startTime,
        exitReason,
        firstOutputTime,
        lastOutputTime,
        timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
        outputEvents: outputEvents.length > 0 ? outputEvents : undefined
      };
      timingMessage = formatTimingInfo(timingInfo);
    }

    if (cleanOutput.trim().length === 0 && !timeoutReached) {
      return {
        content: [{
          type: "text",
          text: `✅ Input executed in process ${pid}.\n📭 (No output produced)${statusMessage}${timingMessage}`
        }],
      };
    }

    // Format response with better structure and consistent emojis
    let responseText = `✅ Input executed in process ${pid}`;

    if (cleanOutput && cleanOutput.trim().length > 0) {
      responseText += `:\n\n📤 Output:\n${cleanOutput}`;
    } else {
      responseText += `.\n📭 (No output produced)`;
    }

    if (statusMessage) {
      responseText += `\n\n${statusMessage}`;
    }

    if (truncationMessage) {
      responseText += truncationMessage;
    }

    if (timingMessage) {
      responseText += timingMessage;
    }

    return {
      content: [{
        type: "text",
        text: responseText
      }],
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    capture('server_interact_with_process_error', {
      error: errorMessage
    });
    return {
      content: [{ type: "text", text: `Error interacting with process: ${errorMessage}` }],
      isError: true,
    };
  }
}

/**
 * Built-in prompt regex used when no wait_for is supplied. Matches a line
 * that ends with a typical prompt sentinel (colon / question / >, #, $), a
 * closing paren, or a closing bracket, optionally followed by trailing
 * whitespace. Tested against the LAST line of the newly-printed output only.
 *
 * `]` is included so bracketed choice prompts that don't end in a colon match
 * out of the box — e.g. `Overwrite? [y/N]`, `Select [0-4]`, `(default) [yes]`.
 * (Forms like `[0-4]:` already matched via the trailing `:`.)
 */
const DEFAULT_PROMPT_REGEX_SOURCE = '[:?>#$\\]]\\s*$|\\)\\s*$';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when the tail (last line) of `text` matches `re`.
 * Prompts are usually printed WITHOUT a trailing newline ("Name: "), so we
 * test the segment after the last newline.
 */
function tailMatchesPrompt(text: string, re: RegExp): boolean {
  if (!text) return false;
  const lastNl = text.lastIndexOf('\n');
  const tail = lastNl >= 0 ? text.slice(lastNl + 1) : text;
  return re.test(tail);
}

/**
 * interact_with_process_lines — expect/spawn-style sequential input.
 *
 * Sends each line and waits for the next prompt to ACTUALLY appear before
 * sending the following line. This is the reliable alternative to writing a
 * multi-line blob to stdin in one shot: an async line-reader (Rust BufRead,
 * Node readline, shell `read`) would otherwise consume queued newlines before
 * its prompts have flushed, so every later line lands on the wrong prompt.
 */
export async function interactWithProcessLines(args: unknown): Promise<ServerResult> {
  const parsed = InteractWithProcessLinesArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for interact_with_process_lines: ${parsed.error}` }],
      isError: true,
    };
  }

  const {
    pid,
    lines,
    default_wait_for,
    default_timeout_ms,
    default_append_newline,
    settle_ms,
    fail_fast,
    collect_output,
    verbose_timing = false,
  } = parsed.data;

  // Virtual Node sessions don't support incremental stdin prompting.
  if (virtualNodeSessions.has(pid)) {
    return {
      content: [{ type: "text", text: `Error: interact_with_process_lines is not supported for node:local virtual sessions (PID ${pid}). Use interact_with_process with a complete script instead.` }],
      isError: true,
    };
  }

  if (!terminalManager.getSession(pid)) {
    return {
      content: [{ type: "text", text: `Error: No active session for process ${pid}. The process may have exited or doesn't accept input.` }],
      isError: true,
    };
  }

  capture('server_interact_with_process_lines', { pid, lineCount: lines.length });

  const startTime = Date.now();

  // Compile the regex once per distinct source (cheap; lines is small).
  const compile = (src: string | undefined): RegExp =>
    new RegExp(src && src.length > 0 ? src : DEFAULT_PROMPT_REGEX_SOURCE, 'm');

  // Snapshot before the very first send for the aggregated view.
  const aggregateSnapshot = terminalManager.captureOutputSnapshot(pid);

  const perLine: Array<{ index: number; sent: string; matched: boolean; reason: string; ms: number; output?: string }> = [];
  let sentCount = 0;
  let aborted = false;
  let abortReason = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const appendNewline = line.append_newline ?? default_append_newline;
    const lineTimeout = line.timeout_ms ?? default_timeout_ms;
    const useDelay = typeof line.delay_after_ms === 'number';
    const re = compile(line.wait_for ?? default_wait_for);

    const lineSnapshot = terminalManager.captureOutputSnapshot(pid);
    const lineStart = Date.now();

    const ok = terminalManager.sendInputToProcess(pid, line.input, appendNewline);
    sentCount++;
    if (!ok) {
      perLine.push({ index: i, sent: line.input, matched: false, reason: 'send-failed', ms: Date.now() - lineStart });
      aborted = true;
      abortReason = `Failed to send line ${i + 1} — process exited or stdin closed`;
      break;
    }

    // Wait strategy: fixed delay (escape hatch) OR poll for prompt.
    let matched = false;
    let reason = 'prompt-matched';
    if (useDelay) {
      await sleep(line.delay_after_ms as number);
      matched = true;
      reason = 'delay';
    } else {
      const deadline = Date.now() + lineTimeout;
      while (Date.now() < deadline) {
        // Process gone? stop waiting — final state handled after loop.
        if (!terminalManager.getSession(pid) && !isPidAlive(pid)) {
          reason = 'process-exited';
          break;
        }
        const since = lineSnapshot ? (terminalManager.getOutputSinceSnapshot(pid, lineSnapshot) ?? '') : '';
        if (tailMatchesPrompt(since, re)) {
          matched = true;
          break;
        }
        await sleep(30);
      }
      if (!matched && reason === 'prompt-matched') reason = 'timeout';
    }

    const lineOut = lineSnapshot ? (terminalManager.getOutputSinceSnapshot(pid, lineSnapshot) ?? '') : '';

    // Divergence guards: assert WHERE we landed, not just that the tail looks
    // like a prompt. Without these, a flow that bounced back to the main menu
    // (also prompt-shaped) is mistaken for success and the rest of the lines
    // get fed into the wrong context. Invalid regex sources are ignored so a
    // bad guard never silently swallows a real step.
    if (matched && line.abort_if) {
      try {
        if (new RegExp(line.abort_if, 'm').test(lineOut)) { matched = false; reason = 'abort_if'; }
      } catch { /* invalid abort_if regex — skip guard */ }
    }
    if (matched && line.expect) {
      try {
        if (!new RegExp(line.expect, 'm').test(lineOut)) { matched = false; reason = 'expect-missed'; }
      } catch { /* invalid expect regex — skip guard */ }
    }

    if (collect_output === 'per_line') {
      // Bound per-step output so a chatty step can't flood context.
      const capped = lineOut.length > 4000 ? lineOut.slice(0, 4000) + '\n…[truncated]' : lineOut;
      perLine.push({ index: i, sent: line.input, matched, reason, ms: Date.now() - lineStart, output: capped });
    } else {
      perLine.push({ index: i, sent: line.input, matched, reason, ms: Date.now() - lineStart });
    }

    if (!matched && reason === 'timeout' && fail_fast) {
      aborted = true;
      abortReason = `Line ${i + 1} timed out after ${lineTimeout}ms waiting for prompt (/${re.source}/). Stopped (fail_fast).`;
      break;
    }
    // abort_if fired: an explicit danger pattern matched. Stop regardless of
    // fail_fast — the caller opted into "if you see this, definitely stop".
    if (reason === 'abort_if') {
      aborted = true;
      const tail = lineOut.slice(-200).replace(/\s+$/, '');
      abortReason = `Line ${i + 1} hit abort_if (/${line.abort_if}/) — flow diverged, stopped before feeding the rest. Landed on: …${JSON.stringify(tail)}`;
      break;
    }
    // expect missed: we got a prompt but not the one we required. Treat like a
    // timeout w.r.t. fail_fast (default stop) so we don't feed the rest into a
    // wrong context, but allow fail_fast:false to power through.
    if (reason === 'expect-missed' && fail_fast) {
      aborted = true;
      const tail = lineOut.slice(-200).replace(/\s+$/, '');
      abortReason = `Line ${i + 1} did not match expect (/${line.expect}/) — landed somewhere unexpected, stopped (fail_fast). Got: …${JSON.stringify(tail)}`;
      break;
    }
    if (reason === 'process-exited') {
      aborted = true;
      abortReason = `Process ${pid} exited while waiting after line ${i + 1}.`;
      break;
    }

    // Let stdout/stdin settle before the next send.
    if (i < lines.length - 1 && settle_ms > 0) await sleep(settle_ms);
  }

  // Final state + aggregated output.
  const aggregateRaw = aggregateSnapshot
    ? (terminalManager.getOutputSinceSnapshot(pid, aggregateSnapshot) ?? '')
    : '';
  let cleanOutput = cleanProcessOutput(aggregateRaw, lines.map(l => l.input).join('\n'));

  const config = await configManager.getConfig();
  const maxOutputLines = config.fileReadLineLimit ?? 1000;
  let truncationMessage = '';
  const outLines = cleanOutput.split('\n');
  if (outLines.length > maxOutputLines) {
    cleanOutput = outLines.slice(0, maxOutputLines).join('\n');
    truncationMessage = `\n\n⚠️ Output truncated: ${maxOutputLines} of ${outLines.length} lines. Use read_process_output(pid=${pid}, offset/length) for the rest.`;
  }
  const responseMaxChars = config.responseMaxChars ?? 50000;
  if (cleanOutput.length > responseMaxChars) {
    cleanOutput = applyResponseCharCap(cleanOutput, responseMaxChars, `the earlier output was dropped (tail kept) but is fully retained in the buffer — read it with read_process_output(pid=${pid}, offset=0, length=N) and page forward with a positive line offset`);
  }

  const processState = analyzeProcessState(aggregateRaw, pid);
  let statusMessage = '';
  if (!isPidAlive(pid) && !terminalManager.getSession(pid)) {
    statusMessage = `\n✅ Process ${pid} has finished execution`;
  } else if (processState.isWaitingForInput) {
    statusMessage = `\n🔄 ${formatProcessStateMessage(processState, pid)}`;
  } else {
    statusMessage = `\n🔄 Process ${pid} still running — use read_process_output(pid=${pid}, offset=-50, follow_ms=3000) to tail.`;
  }

  // Build response text.
  const header = aborted
    ? `⚠️ Sent ${sentCount}/${lines.length} lines to process ${pid} — ${abortReason}`
    : `✅ Sent ${sentCount}/${lines.length} lines to process ${pid}`;

  const stepSummary = perLine.map(p => {
    const tag = p.matched ? '✓' : '✗';
    const out = p.output !== undefined ? `\n     ↳ ${p.output.replace(/\n/g, '\n       ')}` : '';
    return `  ${tag} [${p.index + 1}] ${JSON.stringify(p.sent)} → ${p.reason} (${p.ms}ms)${out}`;
  }).join('\n');

  let timingMessage = '';
  if (verbose_timing) {
    timingMessage = `\n\n📊 Timing: ${Date.now() - startTime}ms total`;
  }

  let responseText = `${header}\n\n${stepSummary}`;
  if (cleanOutput && cleanOutput.trim().length > 0) {
    responseText += `\n\n📤 Output:\n${cleanOutput}`;
  }
  responseText += statusMessage + truncationMessage + timingMessage;

  return {
    content: [{ type: "text", text: responseText }],
    isError: aborted ? true : false,
  };
}

/**
 * Force terminate a process
 */
export async function forceTerminate(args: unknown): Promise<ServerResult> {
  const parsed = ForceTerminateArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for force_terminate: ${parsed.error}` }],
      isError: true,
    };
  }

  const pid = parsed.data.pid;

  // Handle virtual Node.js sessions (node:local)
  if (virtualNodeSessions.has(pid)) {
    virtualNodeSessions.delete(pid);
    return {
      content: [{
        type: "text",
        text: `Cleared virtual Node.js session ${pid}`
      }],
    };
  }

  const success = terminalManager.forceTerminate(pid);
  return {
    content: [{
      type: "text",
      text: success
        ? `Successfully initiated termination of session ${pid}`
        : `No active session found for PID ${pid}`
    }],
  };
}

/**
 * List active sessions
 */
export async function listSessions(): Promise<ServerResult> {
  const sessions = terminalManager.listActiveSessions();

  // Include virtual Node.js sessions
  const virtualSessions = Array.from(virtualNodeSessions.entries()).map(([pid, session]) => ({
    pid,
    type: 'node:local',
    timeout_ms: session.timeout_ms
  }));

  const realSessionsText = sessions.map(s =>
    `PID: ${s.pid}, Blocked: ${s.isBlocked}, Runtime: ${Math.round(s.runtime / 1000)}s`
  );

  const virtualSessionsText = virtualSessions.map(s =>
    `PID: ${s.pid} (node:local), Timeout: ${s.timeout_ms}ms`
  );

  const allSessions = [...realSessionsText, ...virtualSessionsText];

  return {
    content: [{
      type: "text",
      text: allSessions.length === 0
        ? 'No active sessions'
        : allSessions.join('\n')
    }],
  };
}