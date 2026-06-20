/**
 * REPL and Process State Detection Utilities
 * Detects when processes are waiting for input vs finished vs running
 */

export interface ProcessState {
  isWaitingForInput: boolean;
  isFinished: boolean;
  isRunning: boolean;
  detectedPrompt?: string;
  lastOutput: string;
}

// Common REPL prompt patterns
const REPL_PROMPTS = {
  python: ['>>> ', '... '],
  node: ['> ', '... '],
  r: ['> ', '+ '],
  julia: ['julia> ', '       '], // julia continuation is spaces
  shell: ['$ ', '# ', '% ', 'bash-', 'zsh-'],
  mysql: ['mysql> ', '    -> '],
  postgres: ['=# ', '-# '],
  redis: ['redis> '],
  mongo: ['> ', '... ']
};

/**
 * Application-level prompt patterns. Triggered ONLY when the cursor is parked
 * on a partial line (output doesn't end with newline) — this is the strongest
 * "we are blocked on input" signal. Without the partial-line gate these
 * patterns would false-match on regular log output ("INFO: starting up\n").
 *
 * Covers the practical universe of CLI prompts AI agents encounter:
 *   - Word-prefix-then-colon:  "Enter X: ", "Password: ", "Choice: "
 *   - Yes/no choices:          "(y/n) ", "(y/N) ", "[Y/n] "
 *   - Generic colon-end:       "Anything: " on a partial line
 *   - Generic question-end:    "Anything? " on a partial line
 *   - Chinese:                 "请输入...:" / "请选择...:" / "确认...?"
 *   - Continuation prompts:    "Press ... to continue"
 *   - Bracket-style picker:    "(1/2/3): " or "[1-9]: "
 *
 * The shell prompt characters (`>` `#` `$` `%`) on partial lines are also
 * covered separately by REPL_PROMPTS / quickPromptPatterns elsewhere.
 */
const APP_PROMPT_PATTERNS: RegExp[] = [
  // Word + ":" (English)
  /\b(enter|input|select|choose|choice|password|username|user|name|email|address|key|number|value|filename|path|url|host|port|version|continue|press|confirm|yes|no|y\/n|y\/n\?|option|action|command|step|stage|phase)\b[^\n]*[:?]\s*$/i,
  // Yes/no inline picker — "(y/n)" / "[Y/n]" / "(yes/no)"
  /[\(\[]\s*[YyNn](?:es|o)?\s*[\/|]\s*[YyNn](?:es|o)?\s*[\)\]]\s*[:?]?\s*$/,
  // Numeric/letter choice picker — "(1/2/3)", "[a-z]"
  /[\(\[][0-9A-Za-z](?:[\/|\-,][0-9A-Za-z])+[\)\]]\s*[:?]?\s*$/,
  // Chinese application prompts
  /(?:请[\s\S]{0,15}(?:输入|选择|确认|提供|填写|回答)|输入|选择)[^\n]*[:：?？]\s*$/,
  // "Press <X> to continue" / "Press any key"
  /press\s+(?:any\s+)?\S+\s+(?:to|key)[^\n]*$/i,
  // Generic colon-end on partial line: "Foo: " — last-resort, kept narrow by
  // requiring at least one letter before the colon and excluding URLs.
  /(?<!:\/\/[^\s]*)\b\w[\w\-\s.]*\w[:：]\s*$/,
];

// Error patterns that indicate completion (even with errors)
const ERROR_COMPLETION_PATTERNS = [
  /Error:/i,
  /Exception:/i,
  /Traceback/i,
  /SyntaxError/i,
  /NameError/i,
  /TypeError/i,
  /ValueError/i,
  /ReferenceError/i,
  /Uncaught/i,
  /at Object\./i, // Node.js stack traces
  /^\s*\^/m       // Syntax error indicators
];

// Process completion indicators
const COMPLETION_INDICATORS = [
  /Process finished/i,
  /Command completed/i,
  /\[Process completed\]/i,
  /Program terminated/i,
  /Exit code:/i
];

/**
 * Analyze process output to determine current state
 */
export function analyzeProcessState(output: string, pid?: number): ProcessState {
  if (!output || output.trim().length === 0) {
    return {
      isWaitingForInput: false,
      isFinished: false,
      isRunning: true,
      lastOutput: output
    };
  }

  const lines = output.split('\n');
  const lastLine = lines[lines.length - 1] || '';
  const lastFewLines = lines.slice(-3).join('\n');

  // Cursor is parked on the last line iff output doesn't end with newline.
  // This is the strong signal that distinguishes "blocked on prompt" from
  // "still printing log lines". App-level prompt patterns only match here.
  const cursorOnPartialLine = !output.endsWith('\n') && lastLine.length > 0;

  // Check for REPL prompts (waiting for input)
  const allPrompts = Object.values(REPL_PROMPTS).flat();
  const detectedPrompt = allPrompts.find(prompt =>
    lastLine.endsWith(prompt) || lastLine.includes(prompt)
  );

  if (detectedPrompt) {
    return {
      isWaitingForInput: true,
      isFinished: false,
      isRunning: true,
      detectedPrompt,
      lastOutput: output
    };
  }

  // Application-level prompt detection — only when cursor is on a partial line.
  if (cursorOnPartialLine) {
    for (const pat of APP_PROMPT_PATTERNS) {
      if (pat.test(lastLine)) {
        return {
          isWaitingForInput: true,
          isFinished: false,
          isRunning: true,
          detectedPrompt: lastLine.slice(-Math.min(60, lastLine.length)),
          lastOutput: output
        };
      }
    }
  }

  // Check for completion indicators
  const hasCompletionIndicator = COMPLETION_INDICATORS.some(pattern => 
    pattern.test(output)
  );

  if (hasCompletionIndicator) {
    return {
      isWaitingForInput: false,
      isFinished: true,
      isRunning: false,
      lastOutput: output
    };
  }

  // Check for error completion (errors usually end with prompts, but let's be thorough)
  const hasErrorCompletion = ERROR_COMPLETION_PATTERNS.some(pattern => 
    pattern.test(lastFewLines)
  );

  if (hasErrorCompletion) {
    // Errors can indicate completion, but check if followed by prompt
    if (detectedPrompt) {
      return {
        isWaitingForInput: true,
        isFinished: false,
        isRunning: true,
        detectedPrompt,
        lastOutput: output
      };
    } else {
      return {
        isWaitingForInput: false,
        isFinished: true,
        isRunning: false,
        lastOutput: output
      };
    }
  }

  // Default: process is running, not clearly waiting or finished
  return {
    isWaitingForInput: false,
    isFinished: false,
    isRunning: true,
    lastOutput: output
  };
}

/**
 * Clean output by removing prompts and input echoes
 */
export function cleanProcessOutput(output: string, inputSent?: string): string {
  let cleaned = output;

  // Remove input echo if provided
  if (inputSent) {
    const inputLines = inputSent.split('\n');
    inputLines.forEach(line => {
      if (line.trim()) {
        cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(line.trim())}\\s*\n?`, 'm'), '');
      }
    });
  }

  // Remove common prompt patterns from output
  cleaned = cleaned.replace(/^>>>\s*/gm, '');  // Python >>>
  cleaned = cleaned.replace(/^>\s*/gm, '');    // Node.js/Shell >
  cleaned = cleaned.replace(/^\.{3}\s*/gm, ''); // Python ...
  cleaned = cleaned.replace(/^\+\s*/gm, '');   // R +

  // Remove trailing prompts
  cleaned = cleaned.replace(/\n>>>\s*$/, '');
  cleaned = cleaned.replace(/\n>\s*$/, '');
  cleaned = cleaned.replace(/\n\+\s*$/, '');

  return cleaned.trim();
}

/**
 * Escape special regex characters
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Format process state for user display
 */
export function formatProcessStateMessage(state: ProcessState, pid: number): string {
  if (state.isWaitingForInput) {
    // Only show the (detected: "...") fragment when we actually have a
    // non-empty prompt fragment to show. Previously a blank `detectedPrompt`
    // (whitespace-only or all-trimmed-away) produced the cosmetic-but-noisy
    // `(detected: "")` annotation.
    const trimmedPrompt = state.detectedPrompt?.trim();
    return `Process ${pid} is waiting for input${trimmedPrompt ? ` (detected: "${trimmedPrompt}")` : ''}`;
  } else if (state.isFinished) {
    return `Process ${pid} has finished execution`;
  } else {
    return `Process ${pid} is running`;
  }
}
