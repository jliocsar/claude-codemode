// Rows about the tool calls a program makes, off by default: the `run` row
// already shows the program and what it returned, so a row more only repeats
// it. CLAUDE_CODEMODE_CALL_LOG=run adds one dim row summing up each run,
// `calls` a row per call. `$.ui.log` rows never reach the model, and the
// engine leads each with the plugin's name.

import type { EngineInterface } from 'claude-code'

type ToolCallInput = Parameters<EngineInterface['tool']['call']>[0]

// How the call ended, as the relay saw it.
export type CallOutcome = { denied: true } | { denied: false; isError: boolean; text: string }

// CLAUDE_CODEMODE_CALL_LOG: `off` (the default), `run` (a row per run),
// `calls` (a row per call) or `debug` (a row per call, in the debug log alone).
export type CallLogMode = 'run' | 'calls' | 'debug' | 'off'

type CallRecord = { input: ToolCallInput; outcome: CallOutcome }

type FileChange = { path: string; added: number; removed: number }

const COMMAND_CHARACTERS = 80
const LISTED_FILES = 3
const LISTED_PROBLEMS = 2
const EXIT_CODE_LINE = /^Exit code (\d+)/u
// The `cd <dir> &&` a command opens with says where, not what: dropped from rows.
const LEADING_CD = /^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*/u

// The calls of each run still going, by run id, until its row is written.
const runCalls = new Map<string, CallRecord[]>()

function lineCount(text: string) {
  return text === '' ? 0 : text.replace(/\n$/u, '').split('\n').length
}

function shortPath(filePath: string, cwd: string) {
  return filePath.startsWith(`${cwd}/`) ? filePath.slice(cwd.length + 1) : filePath
}

function shownCommand(command: string) {
  const trimmed = command.trim().replace(LEADING_CD, '')
  const line = trimmed.split('\n')[0] ?? ''
  const more = line.length > COMMAND_CHARACTERS || trimmed.includes('\n')

  return more ? `${line.slice(0, COMMAND_CHARACTERS)}…` : line
}

// The lines an Edit or Write changes, from its input: the result's diff is
// not handed back to a plugin in every case. `replace_all` counts one.
function fileChange(input: ToolCallInput, cwd: string): FileChange | undefined {
  if (input.tool === 'Edit') {
    return {
      path: shortPath(input.file_path, cwd),
      added: lineCount(input.new_string),
      removed: lineCount(input.old_string),
    }
  }

  if (input.tool === 'Write') {
    return { path: shortPath(input.file_path, cwd), added: lineCount(input.content), removed: 0 }
  }

  return undefined
}

// What one call did, in a few words: the file and its changed lines, the command.
function callSummary(input: ToolCallInput, cwd: string) {
  const change = fileChange(input, cwd)

  if (change !== undefined) {
    return `${input.tool} ${change.path} +${change.added} −${change.removed}`
  }

  if (input.tool === 'Read') {
    return `Read ${shortPath(input.file_path, cwd)}`
  }

  if (input.tool === 'Bash') {
    return `$ ${shownCommand(input.command)}`
  }

  return input.tool
}

function outcomeNote(outcome: CallOutcome) {
  if (outcome.denied) {
    return ' — denied'
  }

  if (!outcome.isError) {
    return ''
  }

  const exitCode = EXIT_CODE_LINE.exec(outcome.text)?.[1]

  return exitCode === undefined ? ' — failed' : ` — exit ${exitCode}`
}

function isProblem(outcome: CallOutcome) {
  return outcome.denied || outcome.isError
}

// Up to `limit` of the items, and how many more there were.
function listed(items: readonly string[], limit: number) {
  const more = items.length - limit

  return more > 0 ? [...items.slice(0, limit), `+${more} more`].join(', ') : items.join(', ')
}

// Changed files once each, their lines summed over the run's edits.
function changedFiles(calls: readonly CallRecord[], cwd: string) {
  const byPath = new Map<string, FileChange>()

  for (const { input } of calls) {
    const change = fileChange(input, cwd)

    if (change !== undefined) {
      const seen = byPath.get(change.path)
      byPath.set(change.path, {
        path: change.path,
        added: (seen?.added ?? 0) + change.added,
        removed: (seen?.removed ?? 0) + change.removed,
      })
    }
  }

  return [...byPath.values()].map(({ path, added, removed }) => `${path} +${added} −${removed}`)
}

// How many calls of each kind, in the order the run first made them.
function callCounts(calls: readonly CallRecord[]) {
  const counts = new Map<string, number>()

  for (const { input } of calls) {
    const kind = input.tool === 'Bash' ? '$' : input.tool
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }

  return [...counts].map(([kind, count]) => (count === 1 ? kind : `${kind} ×${count}`))
}

export function callLogLine(input: ToolCallInput, outcome: CallOutcome, cwd: string) {
  return `↳ ${callSummary(input, cwd)}${outcomeNote(outcome)}`
}

// One row for a whole run, or null when it called no tool:
// `↳ $ ×7 · Read · Edit ×2 · edited src/a.ts +2 −1 · $ npm test — exit 2`.
export function runSummaryLine(calls: readonly CallRecord[], cwd: string) {
  if (calls.length === 0) {
    return null
  }

  const files = changedFiles(calls, cwd)
  const problems = calls
    .filter(({ outcome }) => isProblem(outcome))
    .map(({ input, outcome }) => `${callSummary(input, cwd)}${outcomeNote(outcome)}`)
  const parts = [
    ...callCounts(calls),
    ...(files.length === 0 ? [] : [`edited ${listed(files, LISTED_FILES)}`]),
    ...(problems.length === 0 ? [] : [listed(problems, LISTED_PROBLEMS)]),
  ]

  return `↳ ${parts.join(' · ')}`
}

export function recordCall(runId: string, input: ToolCallInput, outcome: CallOutcome) {
  runCalls.set(runId, [...(runCalls.get(runId) ?? []), { input, outcome }])
}

// The run's calls, forgotten here once taken.
export function takeRunCalls(runId: string) {
  const calls = runCalls.get(runId) ?? []
  runCalls.delete(runId)

  return calls
}

export function callLogMode(configured: string | undefined): CallLogMode {
  return configured === 'run' || configured === 'calls' || configured === 'debug'
    ? configured
    : 'off'
}
