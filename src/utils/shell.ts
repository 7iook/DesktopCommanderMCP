import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Single source of truth for shells: which shell is the default on this
 * machine, which shells are installed, and how to invoke each of them.
 * Config defaults, system info, process tools, the terminal manager and the
 * config editor all derive their shell choices from here.
 */

// Shell executables Windows can host. Which of them exist is resolved on PATH.
const WINDOWS_SHELLS = ['powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe'];

function isWindows(): boolean {
  return os.platform() === 'win32';
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, isWindows() ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    // Missing or not executable: this candidate isn't a usable shell, the next one is tried
    return false;
  }
}

function windowsExecutableExtensions(): string[] {
  const fromEnv = (process.env.PATHEXT ?? '').split(';').map((ext) => ext.trim()).filter(Boolean);
  return [...new Set(['.EXE', ...fromEnv])];
}

/**
 * Resolves a shell or other program name ("pwsh", "bash.exe", "where") or path
 * ("/bin/zsh") to an executable file. Bare names are searched in PATH's
 * folders only, never the working folder. Returns null when it can't be found.
 */
export function resolveShellPath(shell: string): string | null {
  const name = shell.trim();
  if (!name) return null;

  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return isExecutableFile(name) ? name : null;
  }

  const extensions = isWindows() && !path.extname(name) ? windowsExecutableExtensions() : [''];
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);

  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export function isShellAvailable(shell: string): boolean {
  return resolveShellPath(shell) !== null;
}

/**
 * The full path to start a program by: the one found on PATH. Windows looks
 * for a bare name ("powershell.exe", "cmd", "tasklist") in the working folder
 * before PATH, so a file of that name there would run instead; every program
 * Desktop Commander starts by name goes through here. On Windows a bare name
 * not found on PATH is an error rather than a name Windows would look up in
 * the working folder. A path (absolute, or with a folder in it) is kept as
 * given, and so is a bare name elsewhere, where the working folder isn't searched.
 */
export function resolveProgramPath(program: string): string {
  const resolved = resolveShellPath(program);
  if (resolved) return resolved;
  const name = program.trim();
  if (isWindows() && !name.includes('/') && !name.includes('\\')) {
    throw new Error(`${name} was not found on PATH`);
  }
  return program;
}

/**
 * Standard Windows PATHEXT value, used to repair a corrupted PATHEXT before
 * running a command.
 *
 * On some Windows Claude Desktop / DXT launches the server process inherits a
 * broken PATHEXT (observed as ".CPL" only). Because commands get the server's
 * environment, that broken value would propagate into every spawned shell,
 * stripping ".EXE" and breaking resolution of git / node / python / rg / etc.
 * (and even full-path .exe invocations under PowerShell). See issue #481.
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

/**
 * The environment for what Desktop Commander runs for the AI (start_process
 * commands, node:local code): the server's own, with on Windows what a
 * client's launch broke or left out put back. PATHEXT is repaired (#481).
 * ProgramData is set when missing: a client on the MCP SDK's default
 * environment leaves it out, and Windows OpenSSH (ssh, scp, sftp, ssh-keygen)
 * exits 255 without a word when it's unset (#702). Windows keeps it on the
 * system drive, which the SDK's set does pass (SystemDrive, else SystemRoot's
 * drive); with neither it stays unset.
 */
export function getCommandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (isWindows()) {
    env.PATHEXT = getRepairedPathExt();
    // process.env ignores the name's case on Windows; the copy doesn't, so it's read here
    const drive = process.env.SystemDrive || path.win32.parse(process.env.SystemRoot ?? '').root;
    if (!process.env.ProgramData && drive) {
      env.ProgramData = path.win32.join(drive, '\\', 'ProgramData');
    }
  }
  return env;
}

/**
 * The environment of the shell start_process runs a command in: the
 * command environment, with TERM for better terminal compatibility. The
 * PowerShell helper starts with it too, so the user's profile sees the same.
 */
export function getShellEnvironment(): NodeJS.ProcessEnv {
  return { ...getCommandEnvironment(), TERM: 'xterm-256color' };
}

/**
 * The shell used when the user hasn't configured one.
 * Windows: Windows PowerShell, falling back to %ComSpec%.
 * macOS/Linux: $SHELL, falling back to the OS default shell.
 */
export function getDefaultShell(): string {
  if (isWindows()) {
    if (isShellAvailable('powershell.exe')) return 'powershell.exe';
    return process.env.ComSpec || 'cmd.exe';
  }

  const userShell = process.env.SHELL;
  if (userShell && isShellAvailable(userShell)) return userShell;

  // $SHELL may be unset when launched from a GUI app such as Claude Desktop.
  // zsh is the macOS default since Catalina; /bin/sh is guaranteed by POSIX.
  return os.platform() === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

// Login programs /etc/shells can list that don't run a command given with -c,
// the way every command here starts: terminal multiplexers (screen, tmux),
// git-shell (git commands only), and programs that refuse a login
const NOT_COMMAND_SHELLS = new Set(['nologin', 'false', 'true', 'sync', 'git-shell', 'screen', 'tmux']);

function readEtcShells(): string[] {
  try {
    return fs.readFileSync('/etc/shells', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .filter((line) => !NOT_COMMAND_SHELLS.has(path.basename(line)));
  } catch {
    // Best-effort discovery only: no readable /etc/shells means no extra shells to list
    return [];
  }
}

/**
 * Shells installed on this machine, default shell first. Only shells that
 * resolve to an executable are returned.
 */
export function detectAvailableShells(): string[] {
  const shells = new Set<string>();
  const add = (shell: string | undefined): void => {
    const value = shell?.trim();
    if (value && isShellAvailable(value)) shells.add(value);
  };

  add(getDefaultShell());
  if (isWindows()) {
    WINDOWS_SHELLS.forEach(add);
  } else {
    add(process.env.SHELL);
    readEtcShells().forEach(add);
  }
  return [...shells];
}

// WSL's entry in binfmt_misc that lets Linux run Windows programs. Distros that run systemd get it late, under the second name
const WSL_INTEROP_ENTRIES = ['/proc/sys/fs/binfmt_misc/WSLInterop', '/proc/sys/fs/binfmt_misc/WSLInterop-late'];
let wslInterop = false; // true once the entry was found

/**
 * Whether this is WSL, which runs Windows programs from Linux. WSL sets
 * WSL_DISTRO_NAME for what it starts. What runs without it, through sudo
 * (which clears the environment) or as a service, is known by WSL's interop
 * entry. Once found it is remembered; while missing it is looked for again,
 * since WSL can register it again after it was gone. A Docker container on
 * WSL's kernel has no such entry and can't run Windows programs.
 */
function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  wslInterop ||= WSL_INTEROP_ENTRIES.some((entry) => fs.existsSync(entry));
  return wslInterop;
}

/**
 * A program's name without its folder or extension, lowercased:
 * C:\Windows\System32\NET.EXE is "net". The folder goes as Windows writes it
 * (\ or /, or a drive, as in C:sc.exe). POSIX shells outside Windows use
 * only / as a folder separator. PowerShell also removes .ps1; on Windows
 * and WSL the extensions in the repaired PATHEXT are removed as commands run
 * with them. WSL runs Windows programs from Linux
 * (sc.exe stop Spooler), so there too. The command check compares the names it
 * finds and the blockedCommands entries in this form. POSIX shells on
 * Windows still accept Windows paths, as Git Bash does.
 * Without a shell type, retain the historical PowerShell-style normalization.
 */
export function programName(name: string, shellType: ShellType = 'powershell'): string {
  const paths = shellType === 'posix' && !isWindows() ? path.posix : path.win32;
  const program = paths.basename(name).toLowerCase();
  const extensions = [
    ...(shellType === 'powershell' ? ['.ps1'] : []),
    ...(isWindows() || isWsl() ? getRepairedPathExt().split(';') : []),
  ]
    .map((ext) => ext.trim().toLowerCase());
  const extension = paths.extname(program);
  return extension && extensions.includes(extension) ? program.slice(0, -extension.length) : program;
}

/** The kinds of shell a command can run in. The command check has a reader for each. */
export type ShellType = 'posix' | 'powershell' | 'cmd';

/**
 * Which kind of shell a shell program is, by its name without folder and
 * lowercased, as getShellSpawnArgs() reads it: pwsh and powershell (with or
 * without .exe) are PowerShell, cmd and cmd.exe are cmd, and every other shell
 * (bash, zsh, sh, dash, ksh, fish) is POSIX. getShellSpawnArgs() starts each
 * kind its own way.
 */
export function getShellType(shell: string): ShellType {
  const name = path.basename(shell).toLowerCase();
  if (['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'].includes(name)) return 'powershell';
  if (name === 'cmd' || name === 'cmd.exe') return 'cmd';
  return 'posix';
}

/** The POSIX shells (and fish) by programName(): each runs a script file it's given (bash deploy.sh) */
export const POSIX_SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh', 'ksh93', 'mksh', 'ash', 'fish']);

/**
 * The shell start_process runs a command in: the one asked for, else the
 * defaultShell setting, else this machine's default. The command check reads
 * the command with the same shell.
 */
export function getCommandShell(shell: string | undefined, defaultShell: string | undefined): string {
  return shell || defaultShell || getDefaultShell();
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

/**
 * Re-export the child's real exit status as PowerShell's own.
 *
 * PowerShell reports its *script's* success, not the exit code of the program
 * it ran: `node -e "process.exit(7)"` surfaces as 1. Every distinct failure
 * (127 command-not-found, 2 usage error, 130 SIGINT) collapses into the same
 * uninformative 1, so a caller — human or agent — has to guess why a command
 * failed and often just retries blindly.
 *
 * `$?` must be captured first: reading it is itself a statement, so consulting
 * $LASTEXITCODE beforehand would clobber it.
 *
 * ORDER MATTERS, and the intuitive order is wrong. $LASTEXITCODE is STICKY:
 * only a native executable ever writes it, and nothing clears it afterwards.
 * A failing cmdlet flips $? to False but leaves $LASTEXITCODE holding whatever
 * the last native command left behind — so `node -e "process.exit(0)"; Get-Item
 * <missing>` checked $LASTEXITCODE first, found a stale 0, and reported SUCCESS
 * for a command that failed. Combined with the CLIXML error text being dropped,
 * that produced the worst possible signal: no output, exit code 0, command
 * failed. So $? — which always reflects the LAST statement — is authoritative
 * for failure, and $LASTEXITCODE only supplies the specific code.
 *
 * The remaining case is a native program that exits non-zero: it sets both, and
 * $LASTEXITCODE gives the precise code (7, 127, 2) instead of a flat 1.
 *
 * Interactive sessions (python -i, node REPL) never reach this tail: those
 * commands don't return until the session is terminated.
 */
const POWERSHELL_EXIT_CODE_SUFFIX =
  ';$__dcOk=$?;' +
  'if (-not $__dcOk) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }' +
  'elseif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }' +
  'else { exit 0 }';

// NOTE on cmd.exe and CJK: cmd parses its command line using the OEM code
// page (936/950/...) at spawn time — `chcp 65001` only affects subsequent
// OUTPUT, not the parsing of the literal arguments cmd already received.
// Injecting `chcp 65001` therefore makes things WORSE (OEM-encoded literals
// then get reinterpreted as UTF-8 on output → mojibake). cmd CJK output is
// fundamentally unreliable from a child process; AI agents that need CJK
// output should use `pwsh` or `powershell` instead.

/**
 * Configuration for spawning a shell with appropriate flags
 */
export interface ShellSpawnConfig {
  executable: string;
  args: string[];
  useShellOption: string | boolean;
  // When true, pass args verbatim on Windows (see executeCommand). Only cmd.exe
  // needs this; its quote parsing conflicts with libuv's default \" escaping.
  windowsVerbatim?: boolean;
  // When true, recover PowerShell CLIXML record text and strip its noise from
  // output. Set on pwsh/powershell branches when patchEncoding is on.
  stripCliXml?: boolean;
}

/**
 * Get the appropriate spawn configuration for a given shell
 * This handles login shell flags for different shell types.
 *
 * `patchEncoding` (default true) injects the UTF-8 prefix and -OutputFormat
 * Text for PowerShell; set `disableShellEncodingPatching` config to opt out.
 * PowerShell always runs via -EncodedCommand (no tokenizer mangling of $_,
 * back-ticks, quotes) and re-exports the child's real exit code.
 */
export function getShellSpawnArgs(shellPath: string, command: string, patchEncoding: boolean = true): ShellSpawnConfig {
  const shellName = path.basename(shellPath).toLowerCase();
  const executable = resolveProgramPath(shellPath);

  // Unix shells with login flag support
  if (shellName.includes('bash') || shellName.includes('zsh')) {
    return {
      executable,
      args: ['-l', '-c', command],
      useShellOption: false
    };
  }

  // PowerShell Core (cross-platform, supports -Login)
  if (shellName === 'pwsh' || shellName === 'pwsh.exe') {
    const wrappedCommand =
      (patchEncoding ? POWERSHELL_UTF8_PREFIX + command : command) + POWERSHELL_EXIT_CODE_SUFFIX;
    const args = ['-Login', '-NoLogo', '-NonInteractive'];
    if (patchEncoding) args.push('-OutputFormat', 'Text');  // suppress CLIXML
    args.push('-EncodedCommand', encodePowerShellCommand(wrappedCommand));
    return {
      executable,
      args,
      useShellOption: false,
      stripCliXml: patchEncoding
    };
  }

  // Windows PowerShell 5.1 (no login flag support)
  if (shellName === 'powershell' || shellName === 'powershell.exe') {
    const wrappedCommand =
      (patchEncoding ? POWERSHELL_UTF8_PREFIX + command : command) + POWERSHELL_EXIT_CODE_SUFFIX;
    const args = ['-NoLogo', '-NonInteractive'];
    if (patchEncoding) args.push('-OutputFormat', 'Text');  // suppress CLIXML
    args.push('-EncodedCommand', encodePowerShellCommand(wrappedCommand));
    return {
      executable,
      args,
      useShellOption: false,
      stripCliXml: patchEncoding
    };
  }

  // CMD
  if (shellName === 'cmd' || shellName === 'cmd.exe') {
    return {
      executable,
      args: ['/c', command],
      windowsVerbatim: true,
      useShellOption: false
    };
  }

  // Fish shell (uses -l for login, -c for command)
  if (shellName.includes('fish')) {
    return {
      executable,
      args: ['-l', '-c', command],
      useShellOption: false
    };
  }

  // Unknown/other shells - use shell option for safety
  // This provides a fallback for shells we don't explicitly handle
  return {
    executable: command,
    args: [],
    useShellOption: executable
  };
}
