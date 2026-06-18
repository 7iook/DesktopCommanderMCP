export type ConfigFieldValueType = 'string' | 'number' | 'boolean' | 'array' | 'null';

export type ConfigFieldDefinition = {
  label: string;
  description: string;
  valueType: ConfigFieldValueType;
};

// Single source of truth for user-editable configuration fields.
export const CONFIG_FIELD_DEFINITIONS = {
  blockedCommands: {
    label: 'Blocked Commands',
    description: 'This is your personal safety blocklist. If a command appears here, Desktop Commander will refuse to run it even if a prompt asks for it. Add risky commands you never want executed by mistake.',
    valueType: 'array',
  },
  allowedDirectories: {
    label: 'Allowed Folders',
    description: 'These are the folders Desktop Commander is allowed to read and edit. Think of this as a permission list. Keeping it small is safer. If this list is empty, Desktop Commander can access your entire filesystem.',
    valueType: 'array',
  },
  defaultShell: {
    label: 'Default Shell',
    description: 'This is the shell used for new command sessions (for example /bin/bash or /bin/zsh). Only change this if you know your environment requires a specific shell.',
    valueType: 'string',
  },
  telemetryEnabled: {
    label: 'Anonymous Telemetry',
    description: 'When on, Desktop Commander sends anonymous usage information that helps improve product quality. When off, no telemetry data is sent.',
    valueType: 'boolean',
  },
  fileReadLineLimit: {
    label: 'File Read Limit',
    description: 'Maximum number of lines returned from a file in one read action. Lower numbers keep responses short and safer; higher numbers return more text at once.',
    valueType: 'number',
  },
  fileWriteLineLimit: {
    label: 'File Write Limit',
    description: 'Maximum number of lines that can be written in one edit operation. This helps prevent accidental oversized writes and keeps file changes predictable.',
    valueType: 'number',
  },
  writeFileOverwriteProtection: {
    label: 'Write-File Overwrite Protection',
    description: 'When on (default), write_file with mode="rewrite" refuses to silently overwrite existing files; the caller must pass allowOverwrite=true or use edit_block / mode="append" instead. Turn off to restore the legacy unconditional-rewrite behavior.',
    valueType: 'boolean',
  },
  responseMaxChars: {
    label: 'Response Character Cap',
    description: 'Maximum characters returned in a single tool response. Prevents large directory listings or long process output from overflowing the host context window. Output beyond this cap is truncated with a continuation hint. Default 50000.',
    valueType: 'number',
  },
  initialOutputMaxChars: {
    label: 'Initial Process-Output Cap',
    description: 'Maximum characters from the initial output buffer included in start_process response. Per-session ring buffer keeps the full output (50MB cap), readable via read_process_output. Default 16000.',
    valueType: 'number',
  },
  defaultProcessCwd: {
    label: 'Default Process Working Directory',
    description: 'Default cwd for start_process when the call does not pass an explicit cwd. Useful when desktop-commander is spawned by a parent (mcphub, remote bridge, etc.) whose own cwd is not where you want commands to run. Path may use ~ for home. Falls back to env DESKTOP_COMMANDER_DEFAULT_CWD, then to the inherited process cwd.',
    valueType: 'string',
  },
} as const satisfies Record<string, ConfigFieldDefinition>;

export type ConfigFieldKey = keyof typeof CONFIG_FIELD_DEFINITIONS;

export const CONFIG_FIELD_KEYS = Object.keys(CONFIG_FIELD_DEFINITIONS) as ConfigFieldKey[];

export function isConfigFieldKey(value: string): value is ConfigFieldKey {
  return Object.prototype.hasOwnProperty.call(CONFIG_FIELD_DEFINITIONS, value);
}
