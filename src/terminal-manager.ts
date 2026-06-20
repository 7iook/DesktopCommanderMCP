import { spawn } from 'child_process';
import path from 'path';
import { TerminalSession, CommandExecutionResult, ActiveSession, TimingInfo, OutputEvent } from './types.js';
import { DEFAULT_COMMAND_TIMEOUT } from './config.js';
import { configManager } from './config-manager.js';
import {capture} from "./utils/capture.js";
import { analyzeProcessState } from './utils/process-detection.js';
import { markHotPathEnter, markHotPathExit } from './utils/main-thread-watchdog.js';

/**
 * Standard Windows PATHEXT value, used to repair a corrupted PATHEXT before
 * spawning child shells.
 *
 * On some Windows Claude Desktop / DXT launches the server process inherits a
 * broken PATHEXT (observed as ".CPL" only). Because we build the child env from
 * { ...process.env }, that broken value would propagate into every spawned
 * shell, stripping ".EXE" and breaking resolution of git / node / python / rg /
 * etc. (and even full-path .exe invocations under PowerShell). See issue #481.
 */
const STANDARD_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * Return a healthy PATHEXT for spawned Windows shells.
 * - Unset           -> use the standard list.
 * - Missing ".EXE"  -> corrupted; merge the standard list with whatever was
 *                      present (preserves any extra extensions, order-stable).
 * - Otherwise       -> leave the inherited value untouched.
 */
function getRepairedPathExt(): string {
  const current = process.env.PATHEXT;
  if (!current) return STANDARD_PATHEXT;
  const exts = current.split(';').map(e => e.trim().toUpperCase()).filter(Boolean);
  if (!exts.includes('.EXE')) {
    return [...new Set([...STANDARD_PATHEXT.split(';'), ...exts])].join(';');
  }
  return current;
}

interface CompletedSession {
  pid: number;
  outputLines: string[];       // Line-based buffer (consistent with active sessions)
  exitCode: number | null;
  startTime: Date;
  endTime: Date;
  evictedLines: number;        // Carried over from the active session (see TerminalSession)
  evictedChars: number;
}

/**
 * Output buffering caps. Without a cap, a process emitting enough output makes
 * string concatenation throw "RangeError: Invalid string length" at V8's max
 * string size (~536M chars) inside a stdout 'data' handler — an uncaught
 * exception that kills the whole server (index.ts exits on uncaughtException).
 * The cap also bounds the join() cost in snapshot reads and the periodic
 * process-state scan, both of which are O(total output).
 */
export const MAX_BUFFERED_OUTPUT_CHARS = 50 * 1024 * 1024;  // per session; oldest lines evicted first
const MAX_LINE_CHARS = 1024 * 1024;                  // force-split longer lines so eviction can work
const MAX_WAIT_OUTPUT_CHARS = 2 * 1024 * 1024;       // start_process wait buffer (prompt/state detection)

// Result type for paginated output reading
export interface PaginatedOutputResult {
  lines: string[];
  totalLines: number;
  readFrom: number;            // Starting line of this read
  readCount: number;           // Number of lines returned
  remaining: number;           // Lines remaining after this read
  isComplete: boolean;         // Whether process has finished
  exitCode?: number | null;    // Exit code if completed
  runtimeMs?: number;          // Runtime in milliseconds (for completed processes)
  evictedLines?: number;       // Lines dropped by the buffer cap; when > 0, line numbers are relative to the retained buffer
}

/**
 * Encode a command string for PowerShell's -EncodedCommand parameter.
 *
 * PowerShell's -Command parses the command through its tokenizer before
 * execution: variables ($_, $env:*, $PROFILE), back-ticks, and embedded quotes
 * all go through interpretation, which corrupts commands carrying any of those
 * characters before they ever reach the script body. -EncodedCommand bypasses
 * the tokenizer entirely: PS decodes the base64 UTF-16LE blob and runs the
 * literal string. Fixes upstream issue #350 (and the broken reproduction in
 * E:\MCP\DesktopCommanderMCP\bug.md, where Where-Object {$_.Name ...} was
 * stripped to {.Name ...}).
 *
 * Safe for any command: ASCII, CJK, mixed line endings, embedded quotes.
 */
function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, 'utf16le').toString('base64');
}

/**
 * UTF-8 prefix injected before user PowerShell commands when
 * `disableShellEncodingPatching` is false (default).
 *
 * Why: Windows PowerShell 5.1's [Console]::OutputEncoding defaults to the OEM
 * code page (936/950/...) — child stdout emits non-UTF-8 bytes that Node
 * decodes as UTF-8 → mojibake (claude-code #7332, #46486, #9723). pwsh 7+
 * defaults to UTF-8 but inheriting it from a redirected-stdin spawn isn't
 * reliable. Inject the trio explicitly per-call so the result is independent
 * of the user's PS profile and version.
 *
 * `$ProgressPreference='SilentlyContinue'` suppresses progress records, which
 * PS 5.1 emits on stderr as CLIXML even with `-OutputFormat Text` set. Without
 * this, every PS call dumps ~1KB of `<Obj S="progress">` XML noise that AI
 * agents have no use for.
 */
const POWERSHELL_UTF8_PREFIX =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
  '$OutputEncoding=[System.Text.Encoding]::UTF8;' +
  '[Console]::InputEncoding=[System.Text.Encoding]::UTF8;' +
  "$ProgressPreference='SilentlyContinue';";

// NOTE on cmd.exe and CJK: cmd parses its command line using the OEM code
// page (936/950/...) at spawn time — `chcp 65001` only affects subsequent
// OUTPUT, not the parsing of the literal arguments cmd already received.
// Injecting `chcp 65001` therefore makes things WORSE (OEM-encoded literals
// then get reinterpreted as UTF-8 on output → mojibake). cmd CJK output is
// fundamentally unreliable from a child process; AI agents that need CJK
// output should use `pwsh` or `powershell` instead.

/**
 * Strip PowerShell CLIXML wire-format noise from captured output.
 *
 * When PowerShell's stdin is redirected (i.e. spawned as a child), it emits
 * a "#< CLIXML" header followed by `<Objs>` XML blocks for the progress /
 * information / error streams. PS 5.1 emits these even with -OutputFormat
 * Text because module-loading progress fires BEFORE our $ProgressPreference
 * prefix runs. AI agents have no use for the XML; it just buries real output
 * in 1-2KB of `<Obj S="progress">` noise.
 *
 * Removes:
 *   - "#< CLIXML\r\n" header marker
 *   - any complete "<Objs ...>...</Objs>" XML blocks
 *   - resulting blank-line clusters at the very start of the output
 *
 * Leaves the actual user output (text between CLIXML envelopes) intact.
 */
function stripPsCliXml(text: string): string {
  if (!text || (!text.includes('#< CLIXML') && !text.includes('<Objs'))) return text;
  return text
    .replace(/#< CLIXML\r?\n/g, '')
    .replace(/<Objs [\s\S]*?<\/Objs>/g, '')
    .replace(/^[\r\n]+/, '');
}

/**
 * Configuration for spawning a shell with appropriate flags
 */
interface ShellSpawnConfig {
  executable: string;
  args: string[];
  useShellOption: string | boolean;
  // When true, pass args verbatim on Windows (see executeCommand). Only cmd.exe
  // needs this; its quote parsing conflicts with libuv's default \" escaping.
  windowsVerbatim?: boolean;
  // When true, strip PowerShell CLIXML noise from output before returning.
  // Set on pwsh/powershell branches when patchEncoding is on.
  stripCliXml?: boolean;
}

/**
 * Get the appropriate spawn configuration for a given shell
 * This handles login shell flags for different shell types.
 *
 * `patchEncoding` controls UTF-8 prefix injection (default true). On Windows
 * PowerShell 5.1 / cmd, child stdout emits non-UTF-8 bytes by default, which
 * Node decodes as UTF-8 → mojibake for any non-ASCII output. The prefix
 * switches the child's encoding to UTF-8 for the duration of that one
 * subprocess only. Set `disableShellEncodingPatching` config to opt out.
 *
 * For PowerShell, also injects -OutputFormat Text to suppress CLIXML
 * serialization on redirected stdout (Microsoft's PS-to-PS XML wire format
 * that AI agents have no use for and just adds 1-2KB of XML noise per call).
 */
function getShellSpawnArgs(shellPath: string, command: string, patchEncoding: boolean = true): ShellSpawnConfig {
  const shellName = path.basename(shellPath).toLowerCase();

  // Unix shells with login flag support (default UTF-8 — no prefix needed)
  if (shellName.includes('bash') || shellName.includes('zsh')) {
    return {
      executable: shellPath,
      args: ['-l', '-c', command],
      useShellOption: false
    };
  }

  // PowerShell Core (cross-platform, supports -Login)
  // Use -EncodedCommand instead of -Command to bypass PS's command-line
  // tokenizer; otherwise variables ($_, $env:*), back-ticks, and embedded
  // quotes get mangled before the script body runs (upstream #350, bug.md).
  // -Login still applies — it controls profile loading, not the command source.
  if (shellName === 'pwsh' || shellName === 'pwsh.exe') {
    const wrappedCommand = patchEncoding ? POWERSHELL_UTF8_PREFIX + command : command;
    const args = ['-Login', '-NoLogo', '-NonInteractive'];
    if (patchEncoding) args.push('-OutputFormat', 'Text');  // suppress CLIXML
    args.push('-EncodedCommand', encodePowerShellCommand(wrappedCommand));
    return {
      executable: shellPath,
      args,
      useShellOption: false,
      stripCliXml: patchEncoding
    };
  }

  // Windows PowerShell 5.1 (no -Login support)
  if (shellName === 'powershell' || shellName === 'powershell.exe') {
    const wrappedCommand = patchEncoding ? POWERSHELL_UTF8_PREFIX + command : command;
    const args = ['-NoLogo', '-NonInteractive'];
    if (patchEncoding) args.push('-OutputFormat', 'Text');  // suppress CLIXML
    args.push('-EncodedCommand', encodePowerShellCommand(wrappedCommand));
    return {
      executable: shellPath,
      args,
      useShellOption: false,
      stripCliXml: patchEncoding
    };
  }

  // CMD — encoding patching intentionally NOT applied (see CMD note above).
  if (shellName === 'cmd' || shellName === 'cmd.exe') {
    return {
      executable: shellPath,
      args: ['/c', command],
      windowsVerbatim: true,
      useShellOption: false
    };
  }

  // Fish shell (uses -l for login, -c for command)
  if (shellName.includes('fish')) {
    return {
      executable: shellPath,
      args: ['-l', '-c', command],
      useShellOption: false
    };
  }

  // Unknown/other shells - use shell option for safety
  // This provides a fallback for shells we don't explicitly handle
  return {
    executable: command,
    args: [],
    useShellOption: shellPath
  };
}

export class TerminalManager {
  private sessions: Map<number, TerminalSession> = new Map();
  private completedSessions: Map<number, CompletedSession> = new Map();
  
  /**
   * Send input to a running process
   * @param pid Process ID
   * @param input Text to send to the process
   * @param appendNewline When true (default), append '\n' if the input
   *   doesn't already end with one. Set false to send raw bytes verbatim
   *   (single-key menu pickers, control chars like \u0003 Ctrl+C / \u0004 EOF).
   * @returns Whether input was successfully sent
   */
  sendInputToProcess(pid: number, input: string, appendNewline: boolean = true): boolean {
    const session = this.sessions.get(pid);
    if (!session) {
      return false;
    }

    try {
      if (session.process.stdin && !session.process.stdin.destroyed) {
        // Add a trailing newline only when the caller wants line-buffered
        // input (most prompts). Raw mode (appendNewline=false) is required
        // for control characters and single-key REPL-style readers.
        const finalInput = appendNewline && !input.endsWith('\n') && !input.endsWith('\r\n')
          ? input + '\n'
          : input;
        session.process.stdin.write(finalInput);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Error sending input to process ${pid}:`, error);
      return false;
    }
  }
  
  async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT, shell?: string, collectTiming: boolean = false, cwd?: string, envOverrides?: Record<string, string>): Promise<CommandExecutionResult> {
    // Read config once for shell + encoding-patching decisions. Failure falls
    // back to safe defaults (default shell, encoding patching ON).
    let configShell: string | undefined;
    let patchEncoding = true;
    try {
      const config = await configManager.getConfig();
      configShell = config.defaultShell;
      patchEncoding = config.disableShellEncodingPatching !== true;
    } catch (error) {
      // Keep defaults
    }
    let shellToUse: string | boolean | undefined = shell ?? configShell ?? true;

    // For REPL interactions, we need to ensure stdin, stdout, and stderr are properly configured
    // Note: No special stdio options needed here, Node.js handles pipes by default

    // NOTE: We do NOT auto-inject `ssh -t` here. spawn child stdin is a pipe,
    // not a tty; forcing -t makes ssh print "Pseudo-terminal will not be
    // allocated because stdin is not a terminal." on every call. ssh's
    // default behavior (no -t) already does the right thing — allocates a
    // pty when stdin is a tty, skips when piped. Users who actually need a
    // remote pty can pass `-tt` explicitly. (Removed the legacy auto-`-t`
    // enhancement after observing it was only ever producing stderr noise.)
    let enhancedCommand = command;

    // Get the appropriate spawn configuration for the shell
    let spawnConfig: ShellSpawnConfig;
    let spawnOptions: any;
    
    if (typeof shellToUse === 'string') {
      // Use shell-specific configuration with login flags where appropriate
      spawnConfig = getShellSpawnArgs(shellToUse, enhancedCommand, patchEncoding);
      spawnOptions = {
        env: {
          ...process.env,
          TERM: 'xterm-256color'  // Better terminal compatibility
        },
        windowsHide: true  // Prevent visible console windows on Windows
      };

      // Add shell option if needed (for unknown shells)
      if (spawnConfig.useShellOption) {
        spawnOptions.shell = spawnConfig.useShellOption;
      }
    } else {
      // Boolean or undefined shell - use default shell option behavior
      spawnConfig = {
        executable: enhancedCommand,
        args: [],
        useShellOption: shellToUse
      };
      spawnOptions = {
        shell: shellToUse,
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        },
        windowsHide: true  // Prevent visible console windows on Windows
      };
    }

    // Apply cwd if provided. Caller (startProcess) is responsible for
    // expanding ~ and validating the directory exists; we just trust the
    // resolved absolute path here. If cwd is undefined, spawn inherits the
    // parent process cwd — preserves legacy behavior for callers that don't
    // pass cwd.
    if (cwd) {
      spawnOptions.cwd = cwd;
    }

    // Apply per-call env overrides on top of inherited process.env. Cannot
    // delete inherited vars (only set/override) — use setX in the command
    // itself if you need to unset. Already-merged spawnOptions.env keeps
    // TERM=xterm-256color from above; caller overrides win on conflict.
    if (envOverrides && spawnOptions.env) {
      spawnOptions.env = { ...spawnOptions.env, ...envOverrides };
    }

    // Repair PATHEXT on Windows before spawning. On some Windows DXT launches
    // the server process inherits a corrupted PATHEXT (e.g. ".CPL"), which we
    // would otherwise propagate via { ...process.env } and break command
    // resolution (git, node, python, rg, ...) in the spawned shell. See #481.
    if (process.platform === 'win32' && spawnOptions.env) {
      spawnOptions.env.PATHEXT = getRepairedPathExt();
    }

    // On Windows, when we invoke cmd.exe directly and pass the user's command as a
    // single argument, Node/libuv applies MSVCRT-style quoting that escapes embedded
    // double quotes as \" . cmd.exe does not understand that escaping, so any command
    // containing quotes (e.g. a quoted path with spaces like "C:\Program Files\app.exe")
    // is corrupted before the shell ever parses it. Passing arguments verbatim lets
    // cmd handle its own quoting. Scoped to shells that set windowsVerbatim (cmd only)
    // because PowerShell/pwsh have different quote rules and must NOT use verbatim.
    if (process.platform === 'win32' && spawnConfig.windowsVerbatim) {
      spawnOptions.windowsVerbatimArguments = true;
    }

    // Spawn the process with appropriate arguments
    const childProcess = spawn(spawnConfig.executable, spawnConfig.args, spawnOptions);
    let output = '';

    // Ensure childProcess.pid is defined before proceeding
    if (!childProcess.pid) {
      // Return a consistent error object instead of throwing
      return {
        pid: -1,  // Use -1 to indicate an error state
        output: 'Error: Failed to get process ID. The command could not be executed.',
        isBlocked: false
      };
    }

    const session: TerminalSession = {
      pid: childProcess.pid,
      process: childProcess,
      outputLines: [],           // Line-based buffer
      lastReadIndex: 0,          // Track where "new" output starts
      isBlocked: false,
      startTime: new Date(),
      bufferedChars: 0,
      evictedLines: 0,
      evictedChars: 0,
      stripCliXml: spawnConfig.stripCliXml === true,
      cliXmlCarry: ''
    };

    this.sessions.set(childProcess.pid, session);

    // Timing telemetry
    const startTime = Date.now();
    let firstOutputTime: number | undefined;
    let lastOutputTime: number | undefined;
    const outputEvents: OutputEvent[] = [];
    let exitReason: TimingInfo['exitReason'] = 'timeout';

    return new Promise((resolve) => {
      let resolved = false;
      let periodicCheck: NodeJS.Timeout | null = null;

      // Quick prompt patterns for immediate detection
      const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;

      const resolveOnce = (result: CommandExecutionResult) => {
        if (resolved) return;
        resolved = true;
        if (periodicCheck) clearInterval(periodicCheck);

        // Strip PowerShell CLIXML wire-format noise from output before
        // returning. Done here (not per chunk) because <Objs> blocks can span
        // multiple stdout/stderr data events. The session ring buffer is left
        // raw — if read_process_output is later used on this PID it gets the
        // unfiltered stream (CLIXML is mostly a startup artifact and rarely
        // matters past the initial output).
        if (spawnConfig.stripCliXml && result.output) {
          result.output = stripPsCliXml(result.output);
        }

        // Add timing info if requested
        if (collectTiming) {
          const endTime = Date.now();
          result.timingInfo = {
            startTime,
            endTime,
            totalDurationMs: endTime - startTime,
            exitReason,
            firstOutputTime,
            lastOutputTime,
            timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
            outputEvents: outputEvents.length > 0 ? outputEvents : undefined
          };
        }

        resolve(result);
      };

      childProcess.stdout.on('data', (data: any) => {
        const text = data.toString();
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;

        // `output` only feeds the wait-phase result and prompt/state detection,
        // so stop growing it once resolved and keep only a bounded tail.
        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        // Append to line-based buffer (CLIXML-filtered at the boundary for PS)
        this.appendToLineBuffer(session, this.filterCliXmlStream(session, text));

        // Record output event if collecting timing
        if (collectTiming) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stdout',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }

        // Immediate check for obvious prompts
        if (quickPromptPatterns.test(text)) {
          session.isBlocked = true;
          exitReason = 'early_exit_quick_pattern';

          if (collectTiming && outputEvents.length > 0) {
            outputEvents[outputEvents.length - 1].matchedPattern = 'quick_pattern';
          }

          resolveOnce({
            pid: childProcess.pid!,
            output,
            isBlocked: true
          });
        }
      });

      childProcess.stderr.on('data', (data: any) => {
        const text = data.toString();
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;

        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        // Append to line-based buffer (CLIXML-filtered at the boundary for PS)
        this.appendToLineBuffer(session, this.filterCliXmlStream(session, text));

        // Record output event if collecting timing
        if (collectTiming) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stderr',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }
      });

      // Periodic comprehensive check every 100ms
      periodicCheck = setInterval(() => {
        if (output.trim()) {
          const processState = analyzeProcessState(output, childProcess.pid);
          if (processState.isWaitingForInput) {
            session.isBlocked = true;
            exitReason = 'early_exit_periodic_check';
            resolveOnce({
              pid: childProcess.pid!,
              output,
              isBlocked: true
            });
          }
        }
      }, 100);

      // Timeout fallback
      setTimeout(() => {
        session.isBlocked = true;
        exitReason = 'timeout';
        resolveOnce({
          pid: childProcess.pid!,
          output,
          isBlocked: true
        });
      }, timeoutMs);

      childProcess.on('exit', (code: any) => {
        if (childProcess.pid) {
          // Flush any carried-but-incomplete CLIXML fragment. Run it through
          // the block stripper once more (recovers real text that was carried
          // on a false positive); genuine dangling noise is near-impossible
          // since CLIXML envelopes are well-formed and contiguous.
          if (session.cliXmlCarry) {
            const leftover = stripPsCliXml(session.cliXmlCarry);
            session.cliXmlCarry = '';
            if (leftover) this.appendToLineBuffer(session, leftover);
          }
          // Store completed session before removing active session
          this.completedSessions.set(childProcess.pid, {
            pid: childProcess.pid,
            outputLines: [...session.outputLines], // Copy line buffer
            exitCode: code,
            startTime: session.startTime,
            endTime: new Date(),
            evictedLines: session.evictedLines,
            evictedChars: session.evictedChars
          });

          // Keep only last 100 completed sessions
          if (this.completedSessions.size > 100) {
            const oldestKey = Array.from(this.completedSessions.keys())[0];
            this.completedSessions.delete(oldestKey);
          }

          this.sessions.delete(childProcess.pid);
        }
        exitReason = 'process_exit';
        resolveOnce({
          pid: childProcess.pid!,
          output,
          isBlocked: false
        });
      });
    });
  }

  /**
   * Streaming CLIXML filter for PowerShell sessions, applied at the write
   * boundary (before appendToLineBuffer) so the ring buffer is the single
   * clean source of truth for every reader (read_process_output, snapshots,
   * getNewOutput, interact_with_process_lines).
   *
   * PS 5.1 emits a `#< CLIXML\r\n<Objs ...>...</Objs>` envelope on stderr for
   * progress/error records even with -OutputFormat Text. Previously only the
   * wait-phase result.output was scrubbed; the raw stream still polluted the
   * buffer AND its leading "#< CLIXML" line shifted every real line by one.
   *
   * Envelopes can split across stdout/stderr data chunks, so an incomplete
   * trailing construct (a "<Objs" with no "</Objs>" yet, or a partial
   * "#< CLIXML" header) is held in session.cliXmlCarry until the next chunk.
   */
  private filterCliXmlStream(session: TerminalSession, text: string): string {
    markHotPathEnter(4, text ? text.length : 0);
    try {
      return this.filterCliXmlStreamImpl(session, text);
    } finally {
      markHotPathExit();
    }
  }

  private filterCliXmlStreamImpl(session: TerminalSession, text: string): string {
    if (!session.stripCliXml || !text) return text;

    let buf = (session.cliXmlCarry ?? '') + text;
    session.cliXmlCarry = '';

    // Drop complete header markers and complete <Objs>...</Objs> blocks.
    buf = buf
      .replace(/#< CLIXML\r?\n/g, '')
      .replace(/<Objs [\s\S]*?<\/Objs>/g, '');

    // Carry an incomplete trailing "<Objs ..." (opened, not yet closed).
    const openIdx = buf.lastIndexOf('<Objs');
    if (openIdx !== -1 && buf.indexOf('</Objs>', openIdx) === -1) {
      session.cliXmlCarry = buf.slice(openIdx);
      buf = buf.slice(0, openIdx);
    } else {
      // Otherwise carry an incomplete "#< CLIXML" header (full marker without
      // its newline yet, or a partial prefix at the very end of the chunk).
      const carryLen = TerminalManager.trailingCliXmlHeaderFragment(buf);
      if (carryLen > 0) {
        session.cliXmlCarry = buf.slice(buf.length - carryLen);
        buf = buf.slice(0, buf.length - carryLen);
      }
    }

    // Safety valve: never let the carry grow unbounded if an assumption is
    // wrong — flush it back rather than swallow real output or leak memory.
    if (session.cliXmlCarry.length > 64 * 1024) {
      buf += session.cliXmlCarry;
      session.cliXmlCarry = '';
    }
    return buf;
  }

  /**
   * Number of trailing chars of `buf` that look like the start of an
   * unterminated "#< CLIXML" header and should be carried to the next chunk.
   * The marker is only valid at stream start or right after a newline, which
   * avoids false-carrying real content that merely ends with '#'.
   */
  private static trailingCliXmlHeaderFragment(buf: string): number {
    const M = '#< CLIXML';
    // Full marker present but not newline-terminated (else the regex removed
    // it): carry from the marker onward.
    const idx = buf.indexOf(M);
    if (idx !== -1 && (idx === 0 || buf[idx - 1] === '\n')) {
      return buf.length - idx;
    }
    // Trailing strict prefix of the marker at a line boundary.
    for (let k = Math.min(M.length - 1, buf.length); k > 0; k--) {
      const start = buf.length - k;
      if (buf.slice(start) === M.slice(0, k) && (start === 0 || buf[start - 1] === '\n')) {
        return k;
      }
    }
    return 0;
  }

  /**
   * Append text to a session's line buffer
   * Handles partial lines and newline splitting
   */
  private appendToLineBuffer(session: TerminalSession, text: string): void {
    if (!text) return;
    markHotPathEnter(3, text.length);
    try {
      this.appendToLineBufferImpl(session, text);
    } finally {
      markHotPathExit();
    }
  }

  private appendToLineBufferImpl(session: TerminalSession, text: string): void {
    if (!text) return;

    // Split text into lines, keeping track of whether text ends with newline
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastFragment = i === lines.length - 1;
      const endsWithNewline = text.endsWith('\n');

      if (session.outputLines.length === 0) {
        // First line ever
        session.outputLines.push(line);
      } else if (i === 0) {
        // First fragment - append to last line (might be partial)
        session.outputLines[session.outputLines.length - 1] += line;
      } else {
        // Subsequent lines - add as new lines
        session.outputLines.push(line);
      }
    }
    // Appended text contributes exactly its length to the joined buffer
    // (its newlines become the join separators).
    session.bufferedChars += text.length;

    // A process printing without newlines grows a single line forever, which
    // eviction can't bound — force-split so no line exceeds MAX_LINE_CHARS.
    // Each inserted break adds one separator to the joined length.
    let lastIndex = session.outputLines.length - 1;
    while (session.outputLines[lastIndex].length > MAX_LINE_CHARS) {
      const overlong = session.outputLines[lastIndex];
      session.outputLines[lastIndex] = overlong.slice(0, MAX_LINE_CHARS);
      session.outputLines.push(overlong.slice(MAX_LINE_CHARS));
      session.bufferedChars += 1;
      lastIndex++;
    }

    // Enforce the per-session cap by evicting the oldest lines. Keeps the
    // buffer far below V8's max string length so concatenation and join()
    // can never throw "Invalid string length" and kill the server.
    //
    // PERF: compute how many oldest lines to drop, then remove them in a SINGLE
    // splice. The previous implementation called Array.shift() once per evicted
    // line — shift() is O(n) (re-indexes the whole array), so evicting K lines
    // from an N-line buffer was O(N*K). On verbose output (typecheck/eslint/
    // trial harnesses emitting hundreds of thousands of short lines near the
    // 50MB cap) every incoming chunk re-triggered thousands of O(N) shifts,
    // pegging the main thread for seconds and freezing the whole MCP server
    // (confirmed by the stall watchdog pointing here). One splice is O(N) total.
    if (session.bufferedChars > MAX_BUFFERED_OUTPUT_CHARS && session.outputLines.length > 1) {
      const maxDrop = session.outputLines.length - 1; // always keep >= 1 line
      let dropCount = 0;
      let freed = 0;
      while (dropCount < maxDrop && (session.bufferedChars - freed) > MAX_BUFFERED_OUTPUT_CHARS) {
        freed += session.outputLines[dropCount].length + 1; // +1 for join separator
        dropCount++;
      }
      if (dropCount > 0) {
        session.outputLines.splice(0, dropCount);
        session.bufferedChars -= freed;
        session.evictedChars += freed;
        session.evictedLines += dropCount;
        session.lastReadIndex = Math.max(0, session.lastReadIndex - dropCount);
      }
    }
  }

  /**
   * Read process output with pagination (like file reading)
   * @param pid Process ID
   * @param offset Line offset: 0=from lastReadIndex, positive=absolute, negative=tail
   * @param length Max lines to return
   * @param updateReadIndex Whether to update lastReadIndex (default: true for offset=0)
   */
  readOutputPaginated(pid: number, offset: number = 0, length: number = 1000): PaginatedOutputResult | null {
    // First check active sessions
    const session = this.sessions.get(pid);
    if (session) {
      const result = this.readFromLineBuffer(
        session.outputLines,
        offset,
        length,
        session.lastReadIndex,
        (newIndex) => { session.lastReadIndex = newIndex; },
        false,
        undefined
      );
      result.evictedLines = session.evictedLines;
      return result;
    }

    // Then check completed sessions
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      const runtimeMs = completedSession.endTime.getTime() - completedSession.startTime.getTime();
      const result = this.readFromLineBuffer(
        completedSession.outputLines,
        offset,
        length,
        0,  // Completed sessions don't track read position
        () => {},  // No-op for completed sessions
        true,
        completedSession.exitCode,
        runtimeMs
      );
      result.evictedLines = completedSession.evictedLines;
      return result;
    }

    return null;
  }

  /**
   * Internal helper to read from a line buffer with offset/length
   */
  private readFromLineBuffer(
    lines: string[],
    offset: number,
    length: number,
    lastReadIndex: number,
    updateLastRead: (index: number) => void,
    isComplete: boolean,
    exitCode?: number | null,
    runtimeMs?: number
  ): PaginatedOutputResult {
    const totalLines = lines.length;
    let startIndex: number;
    let linesToRead: string[];

    if (offset < 0) {
      // Negative offset = start position from end, then read 'length' lines forward
      // e.g., offset=-50, length=10 means: start 50 lines from end, read 10 lines
      const fromEnd = Math.abs(offset);
      startIndex = Math.max(0, totalLines - fromEnd);
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Don't update lastReadIndex for tail reads
    } else if (offset === 0) {
      // offset=0 means "from where I last read" (like getNewOutput)
      startIndex = lastReadIndex;
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Update lastReadIndex for "new output" behavior
      updateLastRead(Math.min(startIndex + linesToRead.length, totalLines));
    } else {
      // Positive offset = absolute position
      startIndex = offset;
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Don't update lastReadIndex for absolute position reads
    }

    const readCount = linesToRead.length;
    const endIndex = startIndex + readCount;
    const remaining = Math.max(0, totalLines - endIndex);

    return {
      lines: linesToRead,
      totalLines,
      readFrom: startIndex,
      readCount,
      remaining,
      isComplete,
      exitCode,
      runtimeMs
    };
  }

  /**
   * Get total line count for a process
   */
  getOutputLineCount(pid: number): number | null {
    const session = this.sessions.get(pid);
    if (session) {
      return session.outputLines.length;
    }

    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      return completedSession.outputLines.length;
    }

    return null;
  }

  /**
   * Legacy method for backward compatibility
   * Returns all new output since last read
   * @param maxLines Maximum lines to return (default: 1000 for context protection)
   * @deprecated Use readOutputPaginated instead
   */
  getNewOutput(pid: number, maxLines: number = 1000): string | null {
    const result = this.readOutputPaginated(pid, 0, maxLines);
    if (!result) return null;

    const output = result.lines.join('\n').trim();

    // For completed sessions, append completion info with runtime
    if (result.isComplete) {
      const runtimeStr = result.runtimeMs !== undefined 
        ? `\nRuntime: ${(result.runtimeMs / 1000).toFixed(2)}s` 
        : '';
      if (output) {
        return `${output}\n\nProcess completed with exit code ${result.exitCode}${runtimeStr}`;
      } else {
        return `Process completed with exit code ${result.exitCode}${runtimeStr}\n(No output produced)`;
      }
    }

    // Add truncation warning if there's more output
    if (result.remaining > 0) {
      return `${output}\n\n[Output truncated: ${result.remaining} more lines available. Use read_process_output with offset/length for full output.]`;
    }

    return output || null;
  }

  /**
   * Capture a snapshot of current output state for interaction tracking.
   * Used by interactWithProcess to know what output existed before sending input.
   */
  captureOutputSnapshot(pid: number): { totalChars: number; lineCount: number } | null {
    const session = this.sessions.get(pid);
    if (session) {
      const fullOutput = session.outputLines.join('\n');
      return {
        // Absolute since process start (includes evicted output), so the
        // offset stays valid even if the cap evicts lines between
        // snapshot and read.
        totalChars: session.evictedChars + fullOutput.length,
        lineCount: session.evictedLines + session.outputLines.length
      };
    }
    return null;
  }

  /**
   * Get output that appeared since a snapshot was taken.
   * This handles the case where output is appended to the last line (REPL prompts).
   * Also checks completed sessions in case process finished between snapshot and poll.
   */
  getOutputSinceSnapshot(pid: number, snapshot: { totalChars: number; lineCount: number }): string | null {
    // Check active session first
    const session = this.sessions.get(pid);
    if (session) {
      return TerminalManager.outputSinceSnapshot(session.outputLines, session.evictedChars, snapshot.totalChars);
    }

    // Fallback to completed sessions - process may have finished between snapshot and poll
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      return TerminalManager.outputSinceSnapshot(completedSession.outputLines, completedSession.evictedChars, snapshot.totalChars);
    }

    return null;
  }

  /**
   * New output since a snapshot, in absolute (since process start) offsets.
   * If eviction dropped part of the unseen output, returns what the buffer
   * still holds — the oldest unseen chars are lost to the cap.
   */
  private static outputSinceSnapshot(outputLines: string[], evictedChars: number, snapshotTotalChars: number): string {
    const fullOutput = outputLines.join('\n');
    const newChars = evictedChars + fullOutput.length - snapshotTotalChars;
    if (newChars <= 0) {
      return ''; // No new output
    }
    return fullOutput.substring(Math.max(0, fullOutput.length - newChars));
  }

    /**
   * Get a session by PID
   * @param pid Process ID
   * @returns The session or undefined if not found
   */
  getSession(pid: number): TerminalSession | undefined {
    return this.sessions.get(pid);
  }

  forceTerminate(pid: number): boolean {
    const session = this.sessions.get(pid);
    if (!session) {
      return false;
    }

    try {
        session.process.kill('SIGINT');
        setTimeout(() => {
          if (this.sessions.has(pid)) {
            session.process.kill('SIGKILL');
          }
        }, 1000);
        return true;
      } catch (error) {
        // Convert error to string, handling both Error objects and other types
        const errorMessage = error instanceof Error ? error.message : String(error);
        capture('server_request_error', {error: errorMessage, message: `Failed to terminate process ${pid}:`});
        return false;
      }
  }

  listActiveSessions(): ActiveSession[] {
    const now = new Date();
    return Array.from(this.sessions.values()).map(session => ({
      pid: session.pid,
      isBlocked: session.isBlocked,
      runtime: now.getTime() - session.startTime.getTime()
    }));
  }

  listCompletedSessions(): CompletedSession[] {
    return Array.from(this.completedSessions.values());
  }
}

export const terminalManager = new TerminalManager();