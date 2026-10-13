import { afterAll, expect, test } from 'bun:test'
import { z } from 'zod'
import { decodeRgbaPng } from './png.ts'
import {
  PDF_PATH,
  patternPath,
  patternPixel,
  run,
  seenToolCalls,
  server,
  SHOT_BASE64,
  SHOT_PATH,
  TEST_TIMEOUT_MS,
  TRICKY_STRING,
  zoomedSummarySchema,
} from './spec-harness.ts'

afterAll(() => {
  server.kill('SIGTERM')
})

test(
  'edit strings from inputs reach the tool byte for byte',
  async () => {
    const reply = await run({
      code: 'const edited = await tools.call("Edit", { file_path: "/x.ts", old_string: inputs.old, new_string: "y" })\nreturn edited.result',
      inputs: { old: TRICKY_STRING },
    })

    expect(JSON.parse(reply.text)).toEqual({
      echoed: { file_path: '/x.ts', old_string: TRICKY_STRING, new_string: 'y' },
    })

    expect(seenToolCalls.at(-1)).toEqual({
      tool: 'Edit',
      file_path: '/x.ts',
      old_string: TRICKY_STRING,
      new_string: 'y',
    })
  },
  TEST_TIMEOUT_MS,
)

test(
  'a type error comes back before anything runs',
  async () => {
    const toolCallsBefore = seenToolCalls.length
    const reply = await run({ code: 'await tools.call("Read", { file_pth: "/x" })' })

    expect(reply.text).toMatch(/^run failed: nothing ran[^]*\nline 1: TS\d+ .*file_pth/u)

    expect(seenToolCalls.length).toBe(toolCallsBefore)
  },
  TEST_TIMEOUT_MS,
)

test(
  'a denied tool call rejects inside the program',
  async () => {
    const reply = await run({
      code: 'try { await tools.call("Bash", { command: "ls" }); return "ran" } catch (error) { return String(error) }',
    })

    expect(reply.text).toMatch(/^Error: Bash denied: not allowed in this test/u)
  },
  TEST_TIMEOUT_MS,
)

test(
  'search finds tools by words, with their input types',
  async () => {
    const reply = await run({ code: 'return await tools.search("search notes")' })

    expect(JSON.parse(reply.text)).toEqual([
      {
        name: 'mcp__notes__search',
        description: 'Search notes by keyword.',
        input: 'Record<string, unknown>',
      },
    ])
  },
  TEST_TIMEOUT_MS,
)

test(
  'a tool outside the catalog fails the type check',
  async () => {
    const reply = await run({ code: 'await tools.call("Write", { file_path: "/x", content: "" })' })

    expect(reply.text).toMatch(/^run failed: [^]*"Write"/u)
  },
  TEST_TIMEOUT_MS,
)

test(
  'result is the text parsed, never the text again or behind Error:, and stdout follows the value',
  async () => {
    const reply = await run({
      code: 'const found = await tools.call("mcp__notes__search", { query: "x" })\nconst missing = await tools.call("Read", { file_path: "/missing" })\nconsole.log("seen")\nreturn [found.result, missing.isError, missing.result]',
    })

    expect(reply).toEqual({
      text: '[{"hits":["x"]},true,"File does not exist."]\n\nstdout:\nseen',
      images: [],
    })
  },
  TEST_TIMEOUT_MS,
)

test(
  'returned pictures travel as images, PDF pages from their files, one only read stays out',
  async () => {
    const returned = await run({
      code: `const shot = await tools.call("Read", { file_path: "${SHOT_PATH}" })\nconst pdf = await tools.call("Read", { file_path: "${PDF_PATH}", pages: "1-2" })\nreturn { shot: shot.result, pages: pdf.result }`,
    })
    const unreturned = await run({
      code: `const shot = await tools.call("Read", { file_path: "${SHOT_PATH}" })\nreturn shot.isError`,
    })

    const { shot, pages } = z
      .object({ shot: z.json(), pages: z.object({ pages: z.json() }) })
      .parse(JSON.parse(returned.text))

    expect(shot).toEqual({ type: 'image', file: { base64: '[image 1]', type: 'image/png' } })
    expect(pages.pages).toEqual([
      { base64: '[image 2]', mediaType: 'image/png' },
      { base64: '[image 3]', mediaType: 'image/png' },
    ])
    expect(returned.images).toEqual([
      { mediaType: 'image/png', base64: SHOT_BASE64 },
      { mediaType: 'image/png', base64: btoa('page one') },
      { mediaType: 'image/png', base64: btoa('page two') },
    ])

    expect(unreturned).toEqual({ text: 'false', images: [] })
  },
  TEST_TIMEOUT_MS,
)

test(
  'zoom asks Read first, then shows the region at its own pixels',
  async () => {
    const reply = await run({
      code: 'const zoomed = await tools.zoom(inputs.path, { x: 1, y: 0, width: 2, height: 5 })\nreturn { zoomed, region: zoomed.region, size: zoomed.file.dimensions }',
      inputs: { path: patternPath },
    })

    expect(seenToolCalls.at(-1)).toEqual({ tool: 'Read', file_path: patternPath })

    expect(reply.images).toHaveLength(1)

    const { region, size } = zoomedSummarySchema.parse(JSON.parse(reply.text))
    const shown = decodeRgbaPng(Buffer.from(reply.images[0]?.base64 ?? '', 'base64'))

    const shownPixel = (column: number, row: number) => {
      const start = (row * shown.width + column) * 4

      return [...shown.pixels.subarray(start, start + 4)]
    }

    expect(region).toEqual({ x: 1, y: 0, width: 2, height: 2 })

    expect([shown.width, shown.height]).toEqual([size.displayWidth, size.displayHeight])

    expect(shown.width).toBe(2000)

    expect(shownPixel(0, 0)).toEqual(patternPixel(1, 0))

    expect(shownPixel(shown.width / region.width, shown.height - 1)).toEqual(patternPixel(2, 1))
  },
  TEST_TIMEOUT_MS,
)
