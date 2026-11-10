// Tool calls a program makes, relayed to the plugin: each goes out as a stdout
// line, and the plugin's answer comes back in a POST to `/answer`.
//
// Each call belongs to a run, so stopping a run fails its waiting calls at once
// and refuses any it makes after.

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { z } from 'zod'
import { type JsonValue, withPageImages, type ZoomRegion, zoomImage } from './image.ts'

export type ToolInput = z.infer<typeof toolInputSchema>

type ToolAnswer = z.infer<typeof toolAnswerSchema>

type AnsweredToolCall = Extract<ToolAnswer, { outcome: 'answered' }>

// What a program's `tools.call` resolves with.
type ToolCallReply = { text: string; isError: boolean; result: JsonValue }

type PendingToolCall = { runId: string; settle: (answer: ToolAnswer) => void }

const TOOL_CALL_PREFIX = 'CODEMODE_TOOL_CALL '
// Lines per Read page when a file is past Read's own size cap.
const READ_PAGE_LINES = 2000
const READ_TOO_LARGE = /exceeds maximum allowed (?:size|tokens)/u

// The engine's stand-in for an output too long to show: a preview and where the whole is.
const PERSISTED_OUTPUT =
  /^<persisted-output>\nOutput too large \([^)]*\)\. Full output saved to: (?<path>[^\n]+)\n/u

// Host function schemas reject `z.unknown()`; a loose object takes any fields.
export const toolInputSchema = z.looseObject({})
export const toolAnswerSchema = z.discriminatedUnion('outcome', [
  z.object({
    callId: z.string(),
    outcome: z.literal('answered'),
    text: z.string(),
    isError: z.boolean(),
    result: z.json(),
  }),
  z.object({ callId: z.string(), outcome: z.enum(['denied', 'failed']), reason: z.string() }),
])

// What the engine's `result` is when it only repeats `text`: see structuredResult.
const echoedResultSchema = z.string().nullable()
const jsonValueSchema = z.json()
const persistedBashSchema = z.looseObject({ stdout: z.string(), persistedOutputPath: z.string() })
const readTextSchema = z.looseObject({
  type: z.literal('text'),
  file: z.looseObject({
    filePath: z.string(),
    content: z.string(),
    numLines: z.int(),
    startLine: z.int(),
    totalLines: z.int(),
  }),
})
const pagedReadInputSchema = z.looseObject({
  offset: z.undefined().optional(),
  limit: z.undefined().optional(),
})

const pendingToolCalls = new Map<string, PendingToolCall>()
// Runs that were stopped: their calls fail rather than reach the plugin.
const stoppedRuns = new Map<string, string>()

// One tool call of a run, with long output whole and a file past Read's size cap read in pages.
export async function callTool(runId: string, tool: string, input: ToolInput) {
  const reply = await relayToolCall(runId, tool, input)

  return tool === 'Read' && reply.isError && READ_TOO_LARGE.test(reply.text)
    ? readInPages(runId, input, reply)
    : reply
}

// Fails the run's waiting calls and refuses its next ones.
export function stopRunCalls(runId: string, reason: string) {
  stoppedRuns.set(runId, reason)

  for (const [callId, pending] of pendingToolCalls) {
    if (pending.runId === runId) {
      settleToolCall({ callId, outcome: 'failed', reason })
    }
  }
}

export function forgetRun(runId: string) {
  stoppedRuns.delete(runId)
}

export function settleToolCall(answer: ToolAnswer) {
  pendingToolCalls.get(answer.callId)?.settle(answer)
  pendingToolCalls.delete(answer.callId)
}

// The relayed Read is the permission check: the server opens the file only
// once Claude Code let the model read it. Read takes absolute paths, and so
// must this, or the two could name different files.
export async function zoomFile(runId: string, filePath: string, region: ZoomRegion) {
  if (!isAbsolute(filePath)) {
    throw new Error(`zoom takes an absolute path, not ${filePath}`)
  }

  const read = await askPlugin(runId, 'Read', { file_path: filePath }, { discardResult: true })

  if (read.isError) {
    throw new Error(`Read failed: ${read.text}`)
  }

  return zoomImage(Bun.file(filePath), region)
}

// `discardResult` asks the plugin to answer with no text or result: the call is
// only a permission check, and an image's bytes have no use here.
async function askPlugin(
  runId: string,
  tool: string,
  input: ToolInput,
  options: { discardResult?: boolean } = {},
) {
  const stopped = stoppedRuns.get(runId)

  if (stopped !== undefined) {
    throw new Error(`${tool} not called: ${stopped}`)
  }

  const callId = crypto.randomUUID()
  const { promise: answered, resolve: settle } = Promise.withResolvers<ToolAnswer>()
  pendingToolCalls.set(callId, { runId, settle })
  const line = { callId, input: { ...input, tool }, ...options }
  process.stdout.write(`${TOOL_CALL_PREFIX}${JSON.stringify(line)}\n`)
  const answer = await answered

  if (answer.outcome === 'answered') {
    return answer
  }

  throw new Error(`${tool} ${answer.outcome}: ${answer.reason}`)
}

async function relayToolCall(runId: string, tool: string, input: ToolInput) {
  const answer = await askPlugin(runId, tool, input)
  const text = await wholeText(answer.text)
  const result = await wholeResult(tool, answer.result)

  return {
    text,
    isError: answer.isError,
    result: structuredResult({ ...answer, text, result }),
  } satisfies ToolCallReply
}

// The engine's `result` is the tool's own record for built-ins (Read's file,
// Bash's streams). For MCP tools it is only `text` again, and for an errored
// call `text` behind an `Error: ` prefix; then it is `text`, parsed when JSON.
function structuredResult(answer: AnsweredToolCall) {
  return echoedResultSchema.safeParse(answer.result).success
    ? (parsedJson(answer.text) ?? answer.text)
    : answer.result
}

function parsedJson(jsonText: string) {
  try {
    const parsed = jsonValueSchema.safeParse(JSON.parse(jsonText))

    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

// The text whole where the engine cut it to a preview and saved the rest.
async function wholeText(text: string) {
  const path = PERSISTED_OUTPUT.exec(text)?.groups?.['path']

  return path !== undefined && (await isToolResultFile(path)) ? Bun.file(path).text() : text
}

// Bash's stdout whole where the engine cut it and saved the rest; Read's PDF
// pages with their pictures; any other result as it was.
async function wholeResult(tool: string, result: JsonValue) {
  if (tool === 'Read') {
    return withPageImages(result)
  }

  const persisted = tool === 'Bash' ? persistedBashSchema.safeParse(result) : undefined

  if (persisted?.success === true && (await isToolResultFile(persisted.data.persistedOutputPath))) {
    return { ...persisted.data, stdout: await Bun.file(persisted.data.persistedOutputPath).text() }
  }

  return result
}

// Only the engine's own saved outputs are read: a `tool-results` directory
// under its projects directory. A tool's text could name any other file.
async function isToolResultFile(path: string) {
  const configDirectory = Bun.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')

  try {
    const [file, projects] = await Promise.all([
      realpath(path),
      realpath(join(configDirectory, 'projects')),
    ])

    return file.startsWith(`${projects}${sep}`) && basename(dirname(file)) === 'tool-results'
  } catch {
    return false
  }
}

// Read past its size cap, when the program asked for the whole file: page by
// page, each a Read of its own, halving the page when one is still too large.
async function readInPages(runId: string, input: ToolInput, tooLarge: ToolCallReply) {
  if (!pagedReadInputSchema.safeParse(input).success) {
    return tooLarge
  }

  const contents: string[] = []
  let offset = 1
  let limit = READ_PAGE_LINES
  let totalLines = Number.POSITIVE_INFINITY
  let filePath = ''

  while (offset <= totalLines) {
    const page = await relayToolCall(runId, 'Read', { ...input, offset, limit })

    if (page.isError && READ_TOO_LARGE.test(page.text) && limit > 1) {
      limit = Math.ceil(limit / 2)
      continue
    }

    const read = readTextSchema.safeParse(page.result)

    if (page.isError || !read.success || read.data.file.numLines === 0) {
      return page.isError ? page : tooLarge
    }

    const { file } = read.data
    contents.push(file.content)
    filePath = file.filePath
    totalLines = file.totalLines
    offset = file.startLine + file.numLines
  }

  const content = contents.join('\n')
  const lines = content.split('\n')

  return {
    text: lines.map((line, index) => `${index + 1}\t${line}`).join('\n'),
    isError: false,
    result: {
      type: 'text',
      file: { filePath, content, numLines: lines.length, startLine: 1, totalLines: lines.length },
    },
  } satisfies ToolCallReply
}
