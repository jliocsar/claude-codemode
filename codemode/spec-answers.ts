// What the spec's stand-in engine answers each tool call with, and the files
// those answers point at. Not a spec itself: spec-harness.ts uses it.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { JsonValue } from './image.ts'
import { encodeRgbaPng } from './png.ts'

export type ToolCallInput = z.infer<typeof toolCallInputSchema>

export const SHOT_PATH = '/shot.png'
export const SHOT_BASE64 = 'c2hvdA=='
export const PDF_PATH = '/doc.pdf'
export const BIG_PATH = '/big.txt'
export const BIG_LINES = Array.from({ length: 4500 }, (_line, index) => `line ${index + 1}`)
export const SLOW_QUERY = 'slow'
export const STUCK_QUERY = 'stuck'
export const WHOLE_OUTPUT = 'the whole output, past the preview'
export const WORK_DIRECTORY = '/work'
export const UNREAD_PATH = '/work/unread.ts'

export const toolCallInputSchema = z.looseObject({ tool: z.string() })

const NOT_READ_YET = 'File has not been read yet. Read it first before writing to it.'
const MISSING_FILE = 'File does not exist.'

// A 4×2 picture, each pixel its own color (patternPixel).
const PATTERN = { width: 4, height: 2 }

const readArgsSchema = z.looseObject({
  file_path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
})
const shellArgsSchema = z.looseObject({ command: z.string() })

// The pattern, and the folder where Read leaves a PDF's pages as pictures.
export const fixtureDirectory = await mkdtemp(join(tmpdir(), 'codemode-spec-'))
export const patternPath = join(fixtureDirectory, 'pattern.png')
await Bun.write(patternPath, encodeRgbaPng({ ...PATTERN, pixels: patternPixels() }))
await Bun.write(join(fixtureDirectory, 'page-2.png'), 'page two')
await Bun.write(join(fixtureDirectory, 'page-1.png'), 'page one')

// Where the engine saves an output too long to show: under its config's projects.
const persistedOutputPath = join(
  fixtureDirectory,
  'projects',
  'project',
  'session',
  'tool-results',
  'output.txt',
)
await Bun.write(persistedOutputPath, WHOLE_OUTPUT)

const SHOT_RECORD = { type: 'image', file: { base64: SHOT_BASE64, type: 'image/png' } }

const READ_RESULTS = new Map<string, JsonValue>([
  [SHOT_PATH, SHOT_RECORD],
  [patternPath, SHOT_RECORD],
  [PDF_PATH, { type: 'parts', file: { outputDir: fixtureDirectory, count: 2 }, firstPage: 1 }],
])

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

function answered(callId: string, text: string, result: JsonValue, isError = false) {
  return { callId, outcome: 'answered', text, isError, result }
}

// What the engine answers: the MCP tool's `result` is its text again, Bash and
// Read as below, Edit and Write refuse a file not read yet, and the rest echo
// their input as a record.
export function cannedAnswer(callId: string, { tool, ...args }: ToolCallInput) {
  if (tool === 'Bash') {
    return shellAnswer(callId, shellArgsSchema.parse(args).command)
  }

  if (tool === 'Read') {
    return readAnswer(callId, readArgsSchema.parse(args))
  }

  if (tool === 'mcp__notes__search') {
    const notesText = JSON.stringify({ hits: [args['query']] })

    return answered(callId, notesText, notesText)
  }

  if (
    (tool === 'Edit' || tool === 'Write') &&
    args['file_path'] === UNREAD_PATH &&
    !unreadFileRead
  ) {
    return answered(callId, NOT_READ_YET, NOT_READ_YET, true)
  }

  return answered(callId, `ok ${tool}`, { echoed: z.json().parse(args) })
}

// Bash as the engine answers it, stdout and stderr merged: `echo <text>`
// prints the text as given, `fail` exits 2, `long` is cut to a preview, and
// `ls` is denied.
function shellAnswer(callId: string, command: string) {
  if (command === 'ls') {
    return { callId, outcome: 'denied', reason: 'not allowed in this test' }
  }

  if (command === 'long') {
    return answered(callId, 'preview', { stdout: 'preview', stderr: '', persistedOutputPath })
  }

  if (command === 'fail') {
    const text = 'Exit code 2\nboom'

    return answered(callId, text, text, true)
  }

  const stdout = command.replace(/^.*?echo /su, '')

  return answered(callId, stdout, { stdout, stderr: '', interrupted: false })
}

// Read hands back READ_RESULTS, pages of the big file, the unread file's
// text (which marks it read), and errors elsewhere as the engine does
// (`result` is `text` behind `Error: `).
function readAnswer(callId: string, args: z.infer<typeof readArgsSchema>) {
  const filePath = args.file_path

  if (filePath === BIG_PATH) {
    return bigFileAnswer(callId, args)
  }

  if (filePath === UNREAD_PATH) {
    unreadFileRead = true
    const file = { filePath, content: 'unread', numLines: 1, startLine: 1, totalLines: 1 }

    return answered(callId, '1\tunread', { type: 'text', file })
  }

  const readResult = READ_RESULTS.get(filePath)

  return readResult === undefined
    ? answered(callId, MISSING_FILE, `Error: ${MISSING_FILE}`, true)
    : answered(callId, 'read', readResult)
}

// Read past its size cap: an error for the whole file, a page of it with
// offset and limit, as the engine does.
function bigFileAnswer(callId: string, { offset, limit }: z.infer<typeof readArgsSchema>) {
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

let unreadFileRead = false
