// One dim transcript row per tool call a program makes: the engine shows
// only the `run` call itself, so without these the person sees no Edit, no
// command, no file read. `$.ui.log` rows never reach the model.

import type { EngineInterface } from 'claude-code'

type ToolCallInput = Parameters<EngineInterface['tool']['call']>[0]

// How the call ended, as the relay saw it.
export type CallOutcome = { denied: true } | { denied: false; isError: boolean; text: string }

// Where the rows go: CLAUDE_CODEMODE_CALL_LOG is `transcript` (the default),
// `debug` (the debug log alone) or `off`.
export type CallLogSink = 'transcript' | 'debug' | 'off'

const COMMAND_CHARACTERS = 80
const EXIT_CODE_LINE = /^Exit code (\d+)/u

function lineCount(text: string) {
  return text === '' ? 0 : text.replace(/\n$/u, '').split('\n').length
}

function shortPath(filePath: string, cwd: string) {
  return filePath.startsWith(`${cwd}/`) ? filePath.slice(cwd.length + 1) : filePath
}

function firstLine(command: string) {
  const line = command.trim().split('\n')[0] ?? ''
  const more = line.length > COMMAND_CHARACTERS || command.trim().includes('\n')

  return more ? `${line.slice(0, COMMAND_CHARACTERS)}…` : line
}

// What the call did, in a few words: the file and its changed lines, the command.
function callSummary(input: ToolCallInput, cwd: string) {
  if (input.tool === 'Edit') {
    const all = input.replace_all === true ? ' (all)' : ''

    return `Edit ${shortPath(input.file_path, cwd)} +${lineCount(input.new_string)} −${lineCount(input.old_string)}${all}`
  }

  if (input.tool === 'Write') {
    return `Write ${shortPath(input.file_path, cwd)} +${lineCount(input.content)}`
  }

  if (input.tool === 'Read') {
    return `Read ${shortPath(input.file_path, cwd)}`
  }

  if (input.tool === 'Bash') {
    return `$ ${firstLine(input.command)}`
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

export function callLogLine(input: ToolCallInput, outcome: CallOutcome, cwd: string) {
  return `codemode ↳ ${callSummary(input, cwd)}${outcomeNote(outcome)}`
}

export function callLogSink(configured: string | undefined): CallLogSink {
  return configured === 'debug' || configured === 'off' ? configured : 'transcript'
}
