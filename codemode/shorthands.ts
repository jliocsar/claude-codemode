// The host side of the program's shorthands, `$`, `read`, `write` and `edit`:
// each one or two relayed tool calls, with what the guest sends and what the
// tools answer parsed here. Relative paths start at the session's directory.

import { resolve } from 'node:path'
import { z } from 'zod'
import { callTool, type ToolInput } from './relay.ts'

export type ShellOutput = { stdout: string; stderr: string; exitCode: number }

export type ShellRequest = z.infer<typeof shellRequestSchema>

export type ReadRequest = z.infer<typeof readRequestSchema>

export type WriteRequest = z.infer<typeof writeRequestSchema>

export type EditRequest = z.infer<typeof editRequestSchema>

// Bun Shell leaves these bare and quotes anything else.
const BARE_WORD = /^[\w@%+=:,./-]+$/u
// A failed command's text opens with its exit code.
const EXIT_CODE_LINE = /^Exit code (\d+)\n?/u
// Edit and Write refuse a file the session has not read yet.
const NOT_READ_YET = /has not been read yet/iu

const shellWordSchema = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((word) => quoteWord(String(word)))

// What `${value}` in `$` becomes, as Bun Shell has it: a word quoted, an
// array's words each quoted and spaced, `{ raw }` as it is.
const shellValueSchema = z.union([
  shellWordSchema,
  z.array(shellWordSchema).transform((words) => words.join(' ')),
  z.object({ raw: z.string() }).transform(({ raw }) => raw),
])

// The values travel as JSON text: what a program interpolates is checked here.
export const shellRequestSchema = z.object({
  runId: z.string(),
  strings: z.array(z.string()),
  valuesJson: z.string(),
  cwd: z.string().optional(),
})

export const readRequestSchema = z.object({
  runId: z.string(),
  path: z.string(),
  offset: z.int().optional(),
  limit: z.int().optional(),
})

export const writeRequestSchema = z.object({
  runId: z.string(),
  path: z.string(),
  content: z.string(),
})

export const editRequestSchema = z.object({
  runId: z.string(),
  path: z.string(),
  oldText: z.string(),
  newText: z.string(),
  all: z.boolean(),
})

const shellValuesSchema = z.array(shellValueSchema)
const bashResultSchema = z.looseObject({ stdout: z.string(), stderr: z.string() })
const readTextResultSchema = z.looseObject({ file: z.looseObject({ content: z.string() }) })

function quoteWord(word: string) {
  return BARE_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
}

// `$`'s command: the template's pieces with each value quoted between them.
function shellCommand({ strings, valuesJson }: ShellRequest) {
  const values = shellValuesSchema.parse(JSON.parse(valuesJson))

  return strings.reduce((command, piece, index) =>
    index === 0 ? piece : `${command}${values[index - 1] ?? ''}${piece}`,
  )
}

// Bash hands back stdout and stderr merged, and a failed command's exit code
// as the first line of its text.
export async function runShell(request: ShellRequest, sessionCwd: string): Promise<ShellOutput> {
  const command = shellCommand(request)
  const reply = await callTool(request.runId, 'Bash', {
    command:
      request.cwd === undefined
        ? command
        : `cd ${quoteWord(resolve(sessionCwd, request.cwd))} && ${command}`,
  })

  if (reply.isError) {
    const exitCode = Number(EXIT_CODE_LINE.exec(reply.text)?.[1] ?? 1)

    return { stdout: reply.text.replace(EXIT_CODE_LINE, ''), stderr: '', exitCode }
  }

  const streams = bashResultSchema.safeParse(reply.result)

  return streams.success
    ? { stdout: streams.data.stdout, stderr: streams.data.stderr, exitCode: 0 }
    : { stdout: reply.text, stderr: '', exitCode: 0 }
}

// The file's text, without Read's line numbers.
export async function readText(
  { runId, path, offset, limit }: ReadRequest,
  sessionCwd: string,
): Promise<string> {
  const input: ToolInput = { file_path: resolve(sessionCwd, path) }

  if (offset !== undefined) {
    input['offset'] = offset
  }

  if (limit !== undefined) {
    input['limit'] = limit
  }

  const reply = await callTool(runId, 'Read', input)

  if (reply.isError) {
    throw new Error(`Read failed: ${reply.text}`)
  }

  const read = readTextResultSchema.safeParse(reply.result)

  return read.success ? read.data.file.content : reply.text
}

export function writeFile({ runId, path, content }: WriteRequest, sessionCwd: string) {
  return callAfterRead(runId, 'Write', { file_path: resolve(sessionCwd, path), content })
}

export function editFile({ runId, path, oldText, newText, all }: EditRequest, sessionCwd: string) {
  return callAfterRead(runId, 'Edit', {
    file_path: resolve(sessionCwd, path),
    old_string: oldText,
    new_string: newText,
    replace_all: all,
  })
}

// Reads the file first when the tool asks for that, then tries again.
async function callAfterRead(
  runId: string,
  tool: 'Write' | 'Edit',
  input: ToolInput & { file_path: string },
) {
  let reply = await callTool(runId, tool, input)

  if (reply.isError && NOT_READ_YET.test(reply.text)) {
    await callTool(runId, 'Read', { file_path: input.file_path })
    reply = await callTool(runId, tool, input)
  }

  if (reply.isError) {
    throw new Error(`${tool} failed: ${reply.text}`)
  }

  return null
}
