// How long things wait, and how a message says it: a promise waited on for
// a while, a duration as people say it, and a tool call named in a message.

import { z } from 'zod'

const DESCRIBED_CHARACTERS = 100
const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS

// A tool call with no answer past this fails, unless its run set another
// limit (CLAUDE_CODEMODE_MAX_TOOL_CALL_MS). Bash stops itself at 10 min at
// the most, so only a call that hung reaches it: an MCP call that never
// returned, an answer lost on its way back, a permission prompt left open.
export const DEFAULT_TOOL_CALL_LIMIT_MS = 15 * 60_000

// What tells one call apart from another of the same tool.
const callDetailSchema = z.looseObject({
  command: z.string().optional(),
  file_path: z.string().optional(),
})

// The promise's value if it settles within `ms`, else undefined.
export async function settledWithin<Value>(promise: Promise<Value>, ms: number) {
  const { promise: waited, resolve: stopWaiting } = Promise.withResolvers<undefined>()
  const waitTimer = setTimeout(stopWaiting, ms, undefined)
  const settled = await Promise.race([promise, waited])
  clearTimeout(waitTimer)

  return settled
}

// `42 s`, `14 min`, `6 h 36 min`.
export function formatDuration(ms: number) {
  if (ms < MINUTE_MS) {
    return `${Math.round(ms / SECOND_MS)} s`
  }

  if (ms < HOUR_MS) {
    return `${Math.round(ms / MINUTE_MS)} min`
  }

  const minutes = Math.round((ms % HOUR_MS) / MINUTE_MS)

  return `${Math.floor(ms / HOUR_MS)} h${minutes === 0 ? '' : ` ${minutes} min`}`
}

// The tool, and Bash's command, a file tool's path or else its input as
// JSON, cut short: `Bash sleep 90; tail -f x.log`.
export function describeCall(tool: string, input: z.infer<typeof callDetailSchema>) {
  const parsed = callDetailSchema.safeParse(input)
  const detail =
    (parsed.success ? (parsed.data.command ?? parsed.data.file_path) : undefined) ??
    JSON.stringify(input)

  if (detail === '{}') {
    return tool
  }

  return detail.length > DESCRIBED_CHARACTERS
    ? `${tool} ${detail.slice(0, DESCRIBED_CHARACTERS)}...`
    : `${tool} ${detail}`
}
