// Tool calls a program makes, relayed to the plugin: each goes out as a stdout
// line, and the plugin's answer comes back in a POST to `/answer`.

import { z } from 'zod'
import { isAbsolute } from 'node:path'
import { withPageImages, type ZoomRegion, zoomImage } from './image.ts'

type AnsweredToolCall = Extract<ToolAnswer, { outcome: 'answered' }>

export type ToolInput = z.infer<typeof toolInputSchema>

type ToolAnswer = z.infer<typeof toolAnswerSchema>

const TOOL_CALL_PREFIX = 'CODEMODE_TOOL_CALL '

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

const pendingToolCalls = new Map<string, (answer: ToolAnswer) => void>()

export async function askPluginToRunTool(tool: string, input: ToolInput) {
  const callId = crypto.randomUUID()
  const { promise: answered, resolve } = Promise.withResolvers<ToolAnswer>()
  pendingToolCalls.set(callId, resolve)
  process.stdout.write(
    `${TOOL_CALL_PREFIX}${JSON.stringify({ callId, input: { ...input, tool } })}\n`,
  )
  const answer = await answered

  if (answer.outcome === 'answered') {
    const result =
      tool === 'Read' ? { ...answer, result: await withPageImages(answer.result) } : answer

    return {
      text: answer.text,
      isError: answer.isError,
      result: structuredResult(result),
    }
  }

  throw new Error(`${tool} ${answer.outcome}: ${answer.reason}`)
}

export function settleToolCall(answer: ToolAnswer) {
  pendingToolCalls.get(answer.callId)?.(answer)
  pendingToolCalls.delete(answer.callId)
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
    const parsed: unknown = JSON.parse(jsonText)

    return parsed
  } catch {
    return undefined
  }
}

// The relayed Read is the permission check: the server opens the file only
// once Claude Code let the model read it. Read takes absolute paths, and so
// must this, or the two could name different files.
export async function zoomFile(filePath: string, region: ZoomRegion) {
  if (!isAbsolute(filePath)) {
    throw new Error(`zoom takes an absolute path, not ${filePath}`)
  }

  const read = await askPluginToRunTool('Read', { file_path: filePath })

  if (read.isError) {
    throw new Error(`Read failed: ${read.text}`)
  }

  return zoomImage(Bun.file(filePath), region)
}
