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

export const TEST_TIMEOUT_MS = 60_000
export const TRICKY_STRING = 'a`b${c}\\d "e" \'f\'\nnext line'
export const SHOT_PATH = '/shot.png'
export const SHOT_BASE64 = 'c2hvdA=='
export const PDF_PATH = '/doc.pdf'

const CATALOG = [
  { name: 'Read', description: 'Reads a file from the local filesystem.' },
  { name: 'Edit', description: 'Performs exact string replacements in files.' },
  { name: 'Bash', description: 'Executes a bash command.' },
  { name: 'mcp__notes__search', description: 'Search notes by keyword.' },
]

// A 4×2 picture, each pixel its own color (patternPixel).
const PATTERN = { width: 4, height: 2 }

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
  env: { ...Bun.env, CODEMODE_REPLY_WAIT_MS: '100' },
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

async function post(path: string, bodyJson: string) {
  const response = await fetch(`http://codemode${path}`, {
    unix: await serverSocketPath,
    method: 'POST',
    body: bodyJson,
  })

  return response.json()
}

// What the model reads: the text, and the images after it.
export async function run(body: { code: string; inputs?: Record<string, string> }) {
  let reply = serverReplySchema.parse(
    await post('/run', JSON.stringify({ ...body, catalog: CATALOG })),
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
  if (tool === 'Bash') {
    return { callId, outcome: 'denied', reason: 'not allowed in this test' }
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

// Stands in for the plugin: answers each tool call with a canned result.
function answerToolCall(line: string) {
  const { callId, input } = toolCallLineSchema.parse(JSON.parse(line))
  seenToolCalls.push(input)
  void post('/answer', JSON.stringify(cannedAnswer(callId, input)))
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
          resolve(line.slice(READY_PREFIX.length))
        } else if (line.startsWith(TOOL_CALL_PREFIX)) {
          answerToolCall(line.slice(TOOL_CALL_PREFIX.length))
        }
      }
    }

    reject(new Error(`codemode server exited with ${String(await server.exited)}`))
  })()

  return promise
}
