import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { createInterface } from 'node:readline'
import { text } from 'node:stream/consumers'
import { after, test } from 'node:test'
import { z } from 'zod'

const READY_PREFIX = 'CODEMODE_READY '
const TOOL_CALL_PREFIX = 'CODEMODE_TOOL_CALL '
const TEST_TIMEOUT_MS = 60_000
const TRICKY_STRING = 'a`b${c}\\d "e" \'f\'\nnext line'

const CATALOG = [
  { name: 'Read', description: 'Reads a file from the local filesystem.' },
  { name: 'Edit', description: 'Performs exact string replacements in files.' },
  { name: 'Bash', description: 'Executes a bash command.' },
  { name: 'mcp__notes__search', description: 'Search notes by keyword.' },
]

const toolCallLineSchema = z.object({
  callId: z.string(),
  input: z.looseObject({ tool: z.string() }),
})

const server = spawn('node', ['server.ts'], {
  cwd: import.meta.dirname,
  stdio: ['ignore', 'pipe', 'ignore'],
})
type ToolCallInput = z.infer<typeof toolCallLineSchema>['input']

const seenToolCalls: ToolCallInput[] = []
const serverSocketPath = waitForServerSocketPath()

async function post(path: string, bodyJson: string) {
  const outgoing = request({ socketPath: await serverSocketPath, path, method: 'POST' })
  const { promise: incoming, resolve, reject } = Promise.withResolvers<NodeJS.ReadableStream>()
  outgoing.on('response', resolve)
  outgoing.on('error', reject)
  outgoing.end(bodyJson)

  return text(await incoming)
}

// The text the model reads.
function run(body: { code: string; inputs?: Record<string, string> }) {
  return post('/run', JSON.stringify({ ...body, catalog: CATALOG }))
}

// What the engine answers: Bash is denied, the MCP tool's `result` is its text
// again, Read errors as the engine does (`result` is `text` behind `Error: `),
// and the rest echo their input as a record.
function cannedAnswer(callId: string, { tool, ...args }: ToolCallInput) {
  if (tool === 'Bash') {
    return { callId, outcome: 'denied', reason: 'not allowed in this test' }
  }

  if (tool === 'mcp__notes__search') {
    const notesText = JSON.stringify({ hits: [args['query']] })

    return { callId, outcome: 'answered', text: notesText, isError: false, result: notesText }
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

function waitForServerSocketPath() {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  server.on('exit', (code) => {
    reject(new Error(`codemode server exited with ${String(code)}`))
  })
  createInterface({ input: server.stdout }).on('line', (line) => {
    if (line.startsWith(READY_PREFIX)) {
      resolve(line.slice(READY_PREFIX.length))
    } else if (line.startsWith(TOOL_CALL_PREFIX)) {
      answerToolCall(line.slice(TOOL_CALL_PREFIX.length))
    }
  })

  return promise
}

after(() => {
  server.kill('SIGTERM')
})

void test(
  'edit strings from inputs reach the tool byte for byte',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const response = await run({
      code: 'const edited = await tools.call("Edit", { file_path: "/x.ts", old_string: inputs.old, new_string: "y" })\nreturn edited.result',
      inputs: { old: TRICKY_STRING },
    })

    assert.deepEqual(JSON.parse(response), {
      echoed: { file_path: '/x.ts', old_string: TRICKY_STRING, new_string: 'y' },
    })

    assert.deepEqual(seenToolCalls.at(-1), {
      tool: 'Edit',
      file_path: '/x.ts',
      old_string: TRICKY_STRING,
      new_string: 'y',
    })
  },
)

void test(
  'a type error comes back before anything runs',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const toolCallsBefore = seenToolCalls.length
    const response = await run({ code: 'await tools.call("Read", { file_pth: "/x" })' })

    assert.match(response, /^run failed: nothing ran[^]*\nline 1: TS\d+ .*file_pth/u)

    assert.equal(seenToolCalls.length, toolCallsBefore)
  },
)

void test(
  'a denied tool call rejects inside the program',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const response = await run({
      code: 'try { await tools.call("Bash", { command: "ls" }); return "ran" } catch (error) { return String(error) }',
    })

    assert.match(response, /^Error: Bash denied: not allowed in this test/u)
  },
)

void test(
  'search finds tools by words, with their input types',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const response = await run({ code: 'return await tools.search("search notes")' })

    assert.deepEqual(JSON.parse(response), [
      {
        name: 'mcp__notes__search',
        description: 'Search notes by keyword.',
        input: 'Record<string, unknown>',
      },
    ])
  },
)

void test(
  'a tool outside the catalog fails the type check',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const response = await run({
      code: 'await tools.call("Write", { file_path: "/x", content: "" })',
    })

    assert.match(response, /^run failed: [^]*"Write"/u)
  },
)

void test(
  'result is the text parsed, never the text again or behind Error:, and stdout follows the value',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const response = await run({
      code: 'const found = await tools.call("mcp__notes__search", { query: "x" })\nconst missing = await tools.call("Read", { file_path: "/missing" })\nconsole.log("seen")\nreturn [found.result, missing.isError, missing.result]',
    })

    assert.equal(response, '[{"hits":["x"]},true,"File does not exist."]\n\nstdout:\nseen')
  },
)
