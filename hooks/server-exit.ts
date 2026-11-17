// Why the codemode server stopped, in words a person can act on. Its stderr
// is mostly the VM runtime's chatter (warm worker pools, snapshots, a forced
// finalize while dying): only a line that reads as an error is kept, and the
// whole tail goes to the debug log instead.

export type ServerExit = { code: number | null; signal: string | null }

const DETAIL_CHARACTERS = 200

// The runtime's own progress lines, and the finalize every killed VM logs.
const NOISE =
  /^(?:agentos-v8-runtime:|ts=\S+ level=(?:trace|debug|info)\b|ERR_AGENTOS_VM_FORCED_PROCESS_FINALIZE\b)/u

const ERROR_WORDS = /error|panic|exception|fatal|cannot|failed|not found/iu

// Control characters and the replacement character separate the runtime's
// lines; a newline is one of them, and stays one.
const SEPARATORS = /[\p{Cc}\u{FFFD}]+/gu

function signalWords(signal: string) {
  if (signal === 'SIGKILL') {
    return 'was killed (SIGKILL: out of memory, or killed from outside)'
  }

  if (signal === 'SIGTERM' || signal === 'SIGINT') {
    return `was stopped from outside (${signal})`
  }

  return `crashed (${signal})`
}

// The last line of the tail that reads as an error, without the runtime's noise.
export function errorLine(stderrTail: string) {
  const lines = stderrTail
    .replace(SEPARATORS, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !NOISE.test(line))
  const found = lines.findLast((line) => ERROR_WORDS.test(line))

  return found === undefined ? undefined : found.slice(0, DETAIL_CHARACTERS)
}

// What follows "the server": `was killed (SIGKILL: …)`, `exited with code 1: <its error>`.
export function describeServerExit({ code, signal }: ServerExit, stderrTail: string) {
  const what = signal === null ? `exited with code ${String(code)}` : signalWords(signal)
  const detail = errorLine(stderrTail)

  return detail === undefined ? what : `${what}: ${detail}`
}
