// The spec's stand-in for the plugin: spawns the real server, answers its tool
// calls with canned results, and posts runs to it. Not a spec itself, so
// `bun test` runs it only through server.spec.ts.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { JsonValue } from './image.ts'
import { encodeRgbaPng } from './png.ts'

const READY_PREFIX = 'CODEMODE_READY '
const TOOL_CALL_PREFIX = 'CODEMODE_TOOL_CALL '
const SLOW_ANSWER_MS = 500

export const TEST_TIMEOUT_MS = 60_000
export const TRICKY_STRING = 'a`b${c}\\d "e" \'f\'\nnext line'
export const SHOT_PATH = '/shot.png'
export const SHOT_BASE64 = 'c2hvdA=='
export const PDF_PATH = '/doc.pdf'
export const BIG_PATH = '/big.txt'
export const BIG_LINES = Array.from({ length: 4500 }, (_line, index) => `line ${index + 1}`)
export const SLOW_QUERY = 'slow'
export const STUCK_QUERY = 'stuck'
export const WHOLE_OUTPUT = 'the whole output, past the preview'

const CATALOG = [
  { name: 'Read', description: 'Reads a file from the local filesystem.' },
  { name: 'Edit', description: 'Performs exact string replacements in files.' },
  { name: 'Bash', description: 'Executes a bash command.' },
  { name: 'mcp__notes__search', description: 'Search notes by keyword.' },
]

// A 4×2 picture, each pixel its own color (patternPixel).
const PATTERN = { width: 4, height: 2 }

const readyLineSchema = z.object({ socketPath: z.string(), pid: z.number() })
const readPageSchema = z.looseObject({
  offset: z.number().optional(),
  limit: z.number().optional(),
})
const toolCallLineSchema = z.object({
  callId: z.string(),
  input: z.looseObject({ tool: z.string() }),
})
const runReplySchema = z.object({
  text: z.string(),
  images: z.array(z.object({ mediaType: z.string(), base64: z.string() })),
})
const serverReplySchema = z.union([
  runReplySchema.extend({ pendingRunId: z.undefined().optional() }),
  z.object({ pendingRunId: z.string() }),
])
export const zoomedSummarySchema = z.object({
  region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  size: z.object({ displayWidth: z.number(), displayHeight: z.number() }),
})

type ToolCallInput = z.infer<typeof toolCallLineSchema>['input']

// The pattern, and the folder where Read leaves a PDF's pages as pictures.
const fixtureDirectory = await mkdtemp(join(tmpdir(), 'codemode-spec-'))
export const patternPath = join(fixtureDirectory, 'pattern.png')
await Bun.write(patternPath, encodeRgbaPng({ ...PATTERN, pixels: patternPixels() }))
await Bun.write(join(fixtureDirectory, 'page-2.png'), 'page two')
await Bun.write(join(fixtureDirectory, 'page-1.png'), 'page one')

// Where the engine saves an output too long to show: under its config's projects.
const toolResultsDirectory = join(
  fixtureDirectory,
  'projects',
  'project',
  'session',
  'tool-results',
)
const persistedOutputPath = join(toolResultsDirectory, 'output.txt')
await Bun.write(persistedOutputPath, WHOLE_OUTPUT)

const SHOT_RECORD = { type: 'image', file: { base64: SHOT_BASE64, type: 'image/png' } }

const READ_RESULTS = new Map<string, JsonValue>([
  [SHOT_PATH, SHOT_RECORD],
  [patternPath, SHOT_RECORD],
  [PDF_PATH, { type: 'parts', file: { outputDir: fixtureDirectory, count: 2 }, firstPage: 1 }],
])

export const server = Bun.spawn(['bun', 'server.ts'], {
  cwd: import.meta.dir,
  stdout: 'pipe',
  stderr: 'ignore',
  // Short, so every run (a type check alone is ~1.5 s) goes through `/wait`.
  // Short host waits too, so a slow tool call takes several rounds.
  env: {
    ...Bun.env,
    CODEMODE_REPLY_WAIT_MS: '100',
    CODEMODE_HOST_WAIT_MS: '100',
    CLAUDE_CONFIG_DIR: fixtureDirectory,
  },
})
export const seenToolCalls: ToolCallInput[] = []
const serverSocketPath = waitForServerSocketPath()

export function patternPixel(column: number, row: number) {
  return [column * 60, row * 200, 255 - column * 60, 255]
}

function patternPixels() {
  return new Uint8Array(
    Array.from({ length: PATTERN.width * PATTERN.height }, (_pixel, index) =>
      patternPixel(index % PATTERN.width, Math.floor(index / PATTERN.width)),
    ).flat(),
  )
}

export async function post(path: string, bodyJson: string) {
  const response = await fetch(`http://codemode${path}`, {
    unix: await serverSocketPath,
    method: 'POST',
    body: bodyJson,
  })

  return response.json()
}

// What the model reads: the text, and the images after it.
export async function run(
  body: { code: string; inputs?: Record<string, string> },
  runId = crypto.randomUUID(),
) {
  let reply = serverReplySchema.parse(
    await post('/run', JSON.stringify({ ...body, runId, catalog: CATALOG })),
  )

  while (reply.pendingRunId !== undefined) {
    reply = serverReplySchema.parse(
      await post('/wait', JSON.stringify({ runId: reply.pendingRunId })),
    )
  }

  return reply
}

// What the engine answers: Bash is denied, the MCP tool's `result` is its text
// again, Read hands back READ_RESULTS and errors elsewhere as the engine does
// (`result` is `text` behind `Error: `); the rest echo their input as a record.
function cannedAnswer(callId: string, { tool, ...args }: ToolCallInput) {
  if (tool === 'Bash' && args['command'] === 'long') {
    const result = { stdout: 'preview', stderr: '', persistedOutputPath }

    return { callId, outcome: 'answered', text: 'preview', isError: false, result }
  }

  if (tool === 'Bash') {
    return { callId, outcome: 'denied', reason: 'not allowed in this test' }
  }

  if (tool === 'Read' && args['file_path'] === BIG_PATH) {
    return bigFileAnswer(callId, readPageSchema.parse(args))
  }

  if (tool === 'mcp__notes__search') {
    const notesText = JSON.stringify({ hits: [args['query']] })

    return { callId, outcome: 'answered', text: notesText, isError: false, result: notesText }
  }

  const readResult = tool === 'Read' ? READ_RESULTS.get(String(args['file_path'])) : undefined

  if (readResult !== undefined) {
    return { callId, outcome: 'answered', text: 'read', isError: false, result: readResult }
  }

  if (tool === 'Read') {
    return {
      callId,
      outcome: 'answered',
      text: 'File does not exist.',
      isError: true,
      result: 'Error: File does not exist.',
    }
  }

  return {
    callId,
    outcome: 'answered',
    text: `ok ${tool}`,
    isError: false,
    result: { echoed: args },
  }
}

// Read past its size cap: an error for the whole file, a page of it with
// offset and limit, as the engine does.
function bigFileAnswer(callId: string, { offset, limit }: z.infer<typeof readPageSchema>) {
  if (offset === undefined || limit === undefined) {
    const text =
      'File content (300KB) exceeds maximum allowed size (256KB). Use offset and limit parameters to read specific portions of the file.'

    return { callId, outcome: 'answered', text, isError: true, result: `Error: ${text}` }
  }

  const lines = BIG_LINES.slice(offset - 1, offset - 1 + limit)
  const file = {
    filePath: BIG_PATH,
    content: lines.join('\n'),
    numLines: lines.length,
    startLine: offset,
    totalLines: BIG_LINES.length,
  }

  return {
    callId,
    outcome: 'answered',
    text: 'page',
    isError: false,
    result: { type: 'text', file },
  }
}

// Stands in for the plugin: answers each tool call with a canned result, a
// slow query after a while and a stuck one never.
function answerToolCall(line: string) {
  const { callId, input } = toolCallLineSchema.parse(JSON.parse(line))
  seenToolCalls.push(input)
  const answerJson = JSON.stringify(cannedAnswer(callId, input))

  if (input['query'] === STUCK_QUERY) {
    return
  }

  setTimeout(
    () => void post('/answer', answerJson),
    input['query'] === SLOW_QUERY ? SLOW_ANSWER_MS : 0,
  )
}

// Reads the server's stdout for the test's life: the ready line settles the
// socket path, each tool call line is answered.
function waitForServerSocketPath() {
  const { promise, resolve, reject } = Promise.withResolvers<string>()

  void (async () => {
    let unfinishedLine = ''

    for await (const chunk of server.stdout.pipeThrough(new TextDecoderStream())) {
      const lines = `${unfinishedLine}${chunk}`.split('\n')
      unfinishedLine = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith(READY_PREFIX)) {
          resolve(readyLineSchema.parse(JSON.parse(line.slice(READY_PREFIX.length))).socketPath)
        } else if (line.startsWith(TOOL_CALL_PREFIX)) {
          answerToolCall(line.slice(TOOL_CALL_PREFIX.length))
        }
      }
    }

    reject(new Error(`codemode server exited with ${String(await server.exited)}`))
  })()

  return promise
}
