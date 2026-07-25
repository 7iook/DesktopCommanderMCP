import path from 'path';
import {configManager} from './config-manager.js';
import {capture} from "./utils/capture.js";

class CommandManager {
    /**
     * "Remote shell" wrappers whose argument list is interpreted by ANOTHER
     * shell (a remote host or another machine), not the local one. The local
     * `blockedCommands` list is meaningless against those — `sudo` inside
     * `ssh host '...'` runs on the remote box; mkfs inside `ssh host '...'`
     * does the same. extractCommands' "recurse into $()/`` ` ``even inside
     * quotes" defense was designed to stop *local* subshell bypass, but for
     * these wrappers it produces false positives that block legitimate
     * remote admin commands.
     *
     * For these wrappers we ONLY validate the wrapper itself — if the user
     * has explicitly blocked `ssh`, the call is rejected; otherwise the
     * remote arguments are not inspected. (bash/sh/docker exec deliberately
     * NOT in this list — they run code on THIS machine.)
     */
    private static REMOTE_SHELL_WRAPPERS = new Set([
        'ssh', 'scp', 'sftp', 'rsync', 'mosh',
    ]);

    getBaseCommand(command: string) {
        return command.split(' ')[0].toLowerCase().trim();
    }

    extractCommands(commandString: string): string[] {
        try {
            // Trim any leading/trailing whitespace
            commandString = commandString.trim();

            // Fast path: when the entire command starts with a known REMOTE
            // shell wrapper, only check the wrapper's base name. Everything
            // after runs on a different host, so the local blocklist
            // semantics (and especially extractCommands' aggressive $()/
            // backtick recursion) do not apply.
            const baseTopCmd = this.getBaseCommand(commandString);
            if (CommandManager.REMOTE_SHELL_WRAPPERS.has(baseTopCmd)) {
                return [baseTopCmd];
            }

            // Define command separators - these are the operators that can chain commands
            const separators = [';', '&&', '||', '|', '&'];

            // This will store our extracted commands
            const commands: string[] = [];

            // Split by common separators while preserving quotes
            let inQuote = false;
            let quoteChar = '';
            let currentCmd = '';
            let escaped = false;

            for (let i = 0; i < commandString.length; i++) {
                const char = commandString[i];

                // Handle escape characters
                if (char === '\\' && !escaped) {
                    escaped = true;
                    currentCmd += char;
                    continue;
                }

                // If this character is escaped, just add it
                if (escaped) {
                    escaped = false;
                    currentCmd += char;
                    continue;
                }

                // Handle quotes (both single and double)
                if ((char === '"' || char === "'") && !inQuote) {
                    inQuote = true;
                    quoteChar = char;
                    currentCmd += char;
                    continue;
                } else if (char === quoteChar && inQuote) {
                    inQuote = false;
                    quoteChar = '';
                    currentCmd += char;
                    continue;
                }

                // Handle $() command substitution even inside quotes (fixes blocklist bypass)
                if (char === '$' && i + 1 < commandString.length && commandString[i + 1] === '(') {
                    const startIndex = i;
                    let openParens = 1;
                    let j = i + 2; // skip past $(
                    while (j < commandString.length && openParens > 0) {
                        if (commandString[j] === '(') openParens++;
                        if (commandString[j] === ')') openParens--;
                        j++;
                    }
                    if (j <= commandString.length && openParens === 0) {
                        const subContent = commandString.substring(i + 2, j - 1);
                        const subCommands = this.extractCommands(subContent);
                        commands.push(...subCommands);
                        i = j - 1;
                        if (!inQuote) {
                            continue;
                        } else {
                            currentCmd += commandString.substring(startIndex, j);
                            continue;
                        }
                    }
                }

                // Handle backtick command substitution even inside quotes
                if (char === '`') {
                    const startIndex = i;
                    let j = i + 1;
                    while (j < commandString.length && commandString[j] !== '`') {
                        j++;
                    }
                    if (j < commandString.length) {
                        const subContent = commandString.substring(i + 1, j);
                        const subCommands = this.extractCommands(subContent);
                        commands.push(...subCommands);
                        i = j;
                        if (!inQuote) {
                            continue;
                        } else {
                            currentCmd += commandString.substring(startIndex, j + 1);
                            continue;
                        }
                    }
                }

                // If we're inside quotes, just add the character
                if (inQuote) {
                    currentCmd += char;
                    continue;
                }

                // Handle subshells - if we see an opening parenthesis, we need to find its matching closing parenthesis
                if (char === '(') {
                    // Find the matching closing parenthesis
                    let openParens = 1;
                    let j = i + 1;
                    while (j < commandString.length && openParens > 0) {
                        if (commandString[j] === '(') openParens++;
                        if (commandString[j] === ')') openParens--;
                        j++;
                    }

                    // Skip to after the closing parenthesis only if properly balanced
                    if (j <= commandString.length && openParens === 0) {
                        const subshellContent = commandString.substring(i + 1, j - 1);
                        // Recursively extract commands from the subshell
                        const subCommands = this.extractCommands(subshellContent);
                        commands.push(...subCommands);

                        // Move position past the subshell
                        i = j - 1;
                        continue;
                    }
                }

                // Check for separators
                let isSeparator = false;
                for (const separator of separators) {
                    if (commandString.startsWith(separator, i)) {
                        // We found a separator - extract the command before it
                        if (currentCmd.trim()) {
                            const baseCommand = this.extractBaseCommand(currentCmd.trim());
                            if (baseCommand) commands.push(baseCommand);
                        }

                        // Move past the separator
                        i += separator.length - 1;
                        currentCmd = '';
                        isSeparator = true;
                        break;
                    }
                }

                if (!isSeparator) {
                    currentCmd += char;
                }
            }

            // Don't forget to add the last command
            if (currentCmd.trim()) {
                const baseCommand = this.extractBaseCommand(currentCmd.trim());
                if (baseCommand) commands.push(baseCommand);
            }

            // Remove duplicates and return
            return [...new Set(commands)];
        } catch (error) {
            // If anything goes wrong, log the error but return the basic command to not break execution
            capture('server_request_error', {
                error: 'Error extracting commands'
            });
            const baseCmd = this.extractBaseCommand(commandString);
            return baseCmd ? [baseCmd] : [];
        }
    }

    // This extracts the actual command name from a command string
    extractBaseCommand(commandStr: string): string | null {
        try {
            // Remove environment variables (patterns like KEY=value)
            const withoutEnvVars = commandStr.replace(/\w+=\S+\s*/g, '').trim();

            // If nothing remains after removing env vars, return null
            if (!withoutEnvVars) return null;

            // Get the first token (the command)
            const tokens = withoutEnvVars.split(/\s+/);
            let firstToken = null;

            // Find the first valid token (skip variables)
            for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i];
                
                // Skip dollar-prefixed tokens (variables) but not $() command substitutions
                if (token.startsWith('$') && !token.startsWith('$(')) {
                    continue;
                }
                
                // Check if it starts with special characters like ( that might indicate it's not a regular command
                if (token[0] === '(') {
                    continue;
                }
                
                firstToken = token;
                break;
            }

            // No valid command token found
            if (!firstToken) {
                return null;
            }

            // handle $() command substitution - extract the inner command
            if (firstToken.startsWith('$(') && firstToken.endsWith(')')) {
                const inner = firstToken.slice(2, -1).trim();
                if (inner) {
                    const innerTokens = inner.split(/\s+/);
                    return path.basename(innerTokens[0]).toLowerCase();
                }
                return null;
            }

            // strip path prefix so /usr/bin/sudo gets caught as "sudo"
            const baseName = path.basename(firstToken);
            return baseName.toLowerCase();
        } catch (error) {
            capture('Error extracting base command');
            return null;
        }
    }

    async validateCommand(command: string): Promise<boolean> {
        try {
            // Get blocked commands from config
            const config = await configManager.getConfig();
            const blockedCommands = config.blockedCommands || [];
            
            // Extract all commands from the command string
            const allCommands = this.extractCommands(command);
            
            // If there are no commands extracted, fall back to base command
            if (allCommands.length === 0) {
                const baseCommand = this.getBaseCommand(command);
                return !blockedCommands.includes(baseCommand);
            }
            
            // Check if any of the extracted commands are in the blocked list
            for (const cmd of allCommands) {
                if (blockedCommands.includes(cmd)) {
                    return false; // Command is blocked
                }
            }
            
            // No commands were blocked
            return true;
        } catch (error) {
            console.error('Error validating command:', error);
            capture('server_validate_command_error', {
                error: error instanceof Error ? error.message : String(error)
            });
            // Fail closed: deny the command if validation encounters an error.
            // This prevents a config read failure from bypassing all command filtering.
            return false;
        }
    }

    /**
     * Detects "batch/mass kill by NAME" command patterns that risk collateral
     * damage to mcphub's stdio MCP servers (which run under generic names like
     * python.exe / node.exe / everything.exe and would be swept by name-based
     * kills).
     *
     * Returns null when the command is safe or does not look like a kill at all.
     * Returns a multi-line warning string (with mcphub whitelist + correct
     * precise-PID usage) when a batch-kill pattern is detected. Callers should
     * surface that string as an error response so the AI reads the guidance and
     * retries with a targeted PID.
     *
     * NOT triggered by:
     *   - taskkill /F /PID <n>
     *   - Stop-Process -Id <n>
     *   - Get-Process (query only)
     *   - Get-CimInstance ... (query only, no delete/terminate)
     */
    checkBatchKillPattern(commandString: string): string | null {
        if (!commandString) return null;
        const s = commandString.trim();

        // Rule 1: taskkill /IM (image-name mass kill) — the classic mcphub-killer
        if (/\btaskkill\b/i.test(s)) {
            const hasIM = /(^|\s)\/im(\s|:|=)/i.test(s);
            const hasPID = /(^|\s)\/pid(\s|:|=)\s*\d+/i.test(s);
            if (hasIM && !hasPID) {
                return this.buildKillWarning(
                    'taskkill /IM (kill by image name)',
                    s,
                    'Use `taskkill /F /PID <pid>` with a specific numeric PID. ' +
                    'Discover PID first: `Get-CimInstance Win32_Process -Filter "Name=\'python.exe\'" | Select ProcessId,ExecutablePath,CommandLine | ft`.'
                );
            }
        }

        // Rule 2: Stop-Process -Name (PowerShell mass kill by name)
        if (/\bStop-Process\b/i.test(s) && /(^|\s)-Name\b/i.test(s)) {
            return this.buildKillWarning(
                'Stop-Process -Name (kill by process name)',
                s,
                'Use `Stop-Process -Id <pid> -Force` with a specific numeric PID from Get-Process/Get-CimInstance.'
            );
        }

        // Rule 3: pipeline into Stop-Process (Get-Process X | Stop-Process style)
        // Safe if the piped source is a Get-Process -Id <n> that already narrows to PIDs.
        if (/\|\s*Stop-Process\b/i.test(s)) {
            const pipedSourceIsIdOnly = /Get-Process\s+-Id\s+\d+(\s*,\s*\d+)*\s*\|\s*Stop-Process\b/i.test(s);
            if (!pipedSourceIsIdOnly) {
                return this.buildKillWarning(
                    'Get-Process | Stop-Process pipeline (mass kill)',
                    s,
                    'Never pipe a name-based Get-Process straight into Stop-Process. Inspect the list first, then `Stop-Process -Id <pid> -Force` for the exact PID(s).'
                );
            }
        }

        // Rule 4: pkill / killall (Linux/WSL — always match by name)
        if (/(^|[\s;&|`(])\s*(pkill|killall)\b/i.test(s)) {
            return this.buildKillWarning(
                'pkill / killall (name-based mass kill)',
                s,
                'These match by name/regex and kill every match. Use `kill -9 <pid>` for a specific PID from `ps -ef | grep <thing>`.'
            );
        }

        // Rule 5: wmic process ... delete | call terminate (without single PID)
        if (/\bwmic\b[^\r\n]*\bprocess\b/i.test(s) && /\b(delete|call\s+terminate)\b/i.test(s)) {
            const hasSinglePid = /\bprocessid\s*=\s*['\"]?\d+['\"]?/i.test(s) || /\bwhere\s+processid\s*=\s*\d+/i.test(s);
            if (!hasSinglePid) {
                return this.buildKillWarning(
                    'wmic process ... delete/terminate (batch)',
                    s,
                    'wmic name-based delete sweeps every match. Prefer `taskkill /F /PID <pid>` with one PID.'
                );
            }
        }

        // Rule 6: Get-CimInstance ... | Remove-CimInstance (CIM version of mass kill)
        if (/\|\s*Remove-CimInstance\b/i.test(s)) {
            return this.buildKillWarning(
                'Get-CimInstance | Remove-CimInstance (CIM mass kill)',
                s,
                'Query first with Get-CimInstance to find the exact ProcessId, then `Stop-Process -Id <pid> -Force` for that one PID only.'
            );
        }

        return null;
    }

    private buildKillWarning(pattern: string, cmd: string, guidance: string): string {
        return [
            '⚠️ BATCH-KILL PATTERN DETECTED — aborted for MCP safety',
            '',
            `Pattern:  ${pattern}`,
            `Command:  ${cmd}`,
            '',
            'WHY BLOCKED: This form kills processes by NAME and will collaterally kill',
            'mcphub\'s stdio MCP servers running under generic names (python.exe / node.exe /',
            'everything.exe / etc). That destroys the current AI session — every MCP tool',
            '(desktop-commander, everything-search, fast-context, jshook, codegraph, ace-tool,',
            'context7, exa, ...) goes down together.',
            '',
            `✅ CORRECT WAY: ${guidance}`,
            '',
            'MCPHUB WHITELIST — never kill a PID whose ExecutablePath or CommandLine contains',
            'ANY of these substrings:',
            '  • mcphub',
            '  • desktop-commander    • DesktopCommanderMCP',
            '  • mcp_server_everything_search / mcp-server-everything',
            '  • fast-context / fast_context',
            '  • jshook / @jshookmcp',
            '  • codegraph',
            '  • ace-tool / .ace-tool',
            '  • E:\\MCP\\   (any subpath)',
            '',
            'REQUIRED WORKFLOW:',
            '  1. Enumerate: Get-CimInstance Win32_Process -Filter "Name=\'<name>\'" | Select ProcessId,ExecutablePath,CommandLine | ft',
            '  2. Report the list back to the user with PIDs and paths',
            '  3. Confirm the target PID is NOT in the whitelist above',
            '  4. Kill precisely: `taskkill /F /PID <pid>` OR `Stop-Process -Id <pid> -Force`',
            '',
            'If the user explicitly said "kill everything of type X including MCPs", ask for',
            'confirmation and pass PIDs one by one — never fall back to name-based batch.'
        ].join('\n');
    }
}

export const commandManager = new CommandManager();
