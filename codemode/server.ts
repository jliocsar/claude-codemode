// The codemode server: a Node process the plugin spawns once per session. It
// owns one Secure Exec VM, runs the model's programs in it, and relays each
// `tools.call` back to the plugin, which runs the real Claude Code tool.
//
// Protocol: requests to the plugin are stdout lines (the plugin reads the
// child's stream); everything else goes over a Unix socket the plugin fetches.

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { createVm, shutdown } from 'secure-exec'
import { z } from 'zod'
import {
  buildTypeCheckPrelude,
  type CatalogEntry,
  catalogEntrySchema,
  loadToolInputTypes,
  searchCatalog,
} from './catalog.ts'

type RunResponse =
  | { ok: true; value: unknown; stdout: string }
  | { ok: false; feedback: string; stdout: string }

type SucceededRun = Extract<RunResponse, { ok: true }>

type AnsweredToolCall = Extract<ToolAnswer, { outcome: 'answered' }>

const READY_PREFIX = 'CODEMODE_READY '
const TOOL_CALL_PREFIX = 'CODEMODE_TOOL_CALL '

// Bash's own max timeout, so one long Bash call fits in one host call.
const HOST_FUNCTION_TIMEOUT_MS = 600_000
// A knob: the whole program, which may chain several long calls.
const RUN_TIMEOUT_MS = 1_800_000
const PARENT_CHECK_INTERVAL_MS = 5_000

// What the program sees as `tools`, over the frozen `codemode` host collection.
const GUEST_PRELUDE =
  'const tools = { call: (name, input) => codemode.call({ name, input }), search: (query) => codemode.search({ query }) };'

// Host function schemas reject `z.unknown()`; a loose object takes any fields.
const toolInputSchema = z.looseObject({})
const runRequestSchema = z.object({
  code: z.string(),
  inputs: z.record(z.string(), z.json()).optional(),
  catalog: z.array(catalogEntrySchema),
})
const toolAnswerSchema = z.discriminatedUnion('outcome', [
  z.object({
    callId: z.string(),
    outcome: z.literal('answered'),
    text: z.string(),
    isError: z.boolean(),
    result: z.json(),
  }),
  z.object({ callId: z.string(), outcome: z.enum(['denied', 'failed']), reason: z.string() }),
])

type ToolInput = z.infer<typeof toolInputSchema>
type ToolAnswer = z.infer<typeof toolAnswerSchema>
type RunInputs = NonNullable<z.infer<typeof runRequestSchema>['inputs']>

// What the engine's `result` is when it only repeats `text`: see structuredResult.
const echoedResultSchema = z.string().nullable()

const pendingToolCalls = new Map<string, (answer: ToolAnswer) => void>()
const toolInputTypes = await loadToolInputTypes()

const vm = await createVm({
  hostFunctions: {
    codemode: {
      call: {
        inputSchema: z
          .object({ name: z.string(), input: toolInputSchema })
          .describe('Run one tool.'),
        execute: ({ name, input }: { name: string; input: ToolInput }) =>
          askPluginToRunTool(name, input),
      },
      search: {
        inputSchema: z
          .object({ query: z.string() })
          .describe('Find tools by words in their name or description.'),
        execute: ({ query }: { query: string }) =>
          searchCatalog(catalogOfCurrentRun, toolInputTypes, query),
      },
    },
  },
  limits: {
    hostFunctions: {
      defaultTimeoutMs: HOST_FUNCTION_TIMEOUT_MS,
      maxTimeoutMs: HOST_FUNCTION_TIMEOUT_MS,
    },
  },
})

const server = createServer((request, response) => {
  void answerRequest(request, response)
})

// A short path in a private directory: Unix socket paths cap near 100 bytes.
const socketDirectory = await mkdtemp(join(tmpdir(), 'codemode-'))
const socketPath = join(socketDirectory, 'run.sock')
const parentProcessId = process.ppid

async function askPluginToRunTool(tool: string, input: ToolInput) {
  const callId = randomUUID()
  const { promise: answered, resolve } = Promise.withResolvers<ToolAnswer>()
  pendingToolCalls.set(callId, resolve)
  process.stdout.write(
    `${TOOL_CALL_PREFIX}${JSON.stringify({ callId, input: { ...input, tool } })}\n`,
  )
  const answer = await answered

  if (answer.outcome === 'answered') {
    return {
      text: answer.text,
      isError: answer.isError,
      result: structuredResult(answer),
    }
  }

  throw new Error(`${tool} ${answer.outcome}: ${answer.reason}`)
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

// What the model reads: the returned value alone (a string as is), or why the
// run failed, then any console output.
function runResultText(response: RunResponse) {
  const body = response.ok ? returnedValueText(response) : `run failed: ${response.feedback}`
  const stdout = response.stdout.trimEnd()

  return stdout === '' ? body : `${body}\n\nstdout:\n${stdout}`
}

function returnedValueText(response: SucceededRun) {
  const returnedString = z.string().safeParse(response.value)

  return returnedString.success ? returnedString.data : JSON.stringify(response.value ?? null)
}

async function runProgram(
  code: string,
  inputs: RunInputs,
  catalog: readonly CatalogEntry[],
): Promise<RunResponse> {
  const typeCheckPrelude = buildTypeCheckPrelude(catalog, toolInputTypes)
  const checked = await vm.typescript.check(`${typeCheckPrelude}${code}\n}\nexport {}\n`)

  if (checked.outcome !== 'succeeded') {
    return { ok: false, feedback: `type check did not run: ${checked.error.message}`, stdout: '' }
  }

  const typeErrors = checked.diagnostics.filter((diagnostic) => diagnostic.category === 'error')

  if (typeErrors.length > 0) {
    const typeCheckPreludeLineCount = typeCheckPrelude.split('\n').length - 1
    const feedback = typeErrors
      .map(
        (diagnostic) =>
          `line ${(diagnostic.line ?? 0) - typeCheckPreludeLineCount}: TS${diagnostic.code} ${diagnostic.message}`,
      )
      .join('\n')

    return {
      ok: false,
      feedback: `nothing ran, the code has type errors:\n${feedback}`,
      stdout: '',
    }
  }

  catalogOfCurrentRun = catalog
  const ran = await vm.typescript.evaluate(`(async () => {\n${GUEST_PRELUDE}\n${code}\n})()`, {
    inputs,
    timeoutMs: RUN_TIMEOUT_MS,
    output: { capture: 'all' },
  })

  if (ran.outcome === 'succeeded') {
    return { ok: true, value: ran.value ?? null, stdout: ran.stdout ?? '' }
  }

  const stderr = ran.stderr ?? ''

  return {
    ok: false,
    feedback: stderr === '' ? ran.error.message : stderr,
    stdout: ran.stdout ?? '',
  }
}

// One program at a time: the VM is shared, and parallel runs would interleave.
async function runAfterPreviousRuns(
  code: string,
  inputs: RunInputs,
  catalog: readonly CatalogEntry[],
) {
  const previousRunsFinished = runQueue
  const { promise: thisRunFinished, resolve: finishThisRun } = Promise.withResolvers<void>()
  runQueue = thisRunFinished
  await previousRunsFinished

  try {
    return await runProgram(code, inputs, catalog)
  } finally {
    finishThisRun()
  }
}

async function answerRequest(request: IncomingMessage, response: ServerResponse) {
  try {
    const body: unknown = JSON.parse(await text(request))

    if (request.url === '/run') {
      const { code, inputs = {}, catalog } = runRequestSchema.parse(body)
      response.end(runResultText(await runAfterPreviousRuns(code, inputs, catalog)))
    } else if (request.url === '/answer') {
      const answer = toolAnswerSchema.parse(body)
      pendingToolCalls.get(answer.callId)?.(answer)
      pendingToolCalls.delete(answer.callId)
      response.end('{}')
    } else {
      response.statusCode = 404
      response.end('{}')
    }
  } catch (cause) {
    response.statusCode = 500
    response.end(`codemode server error: ${String(cause)}`)
  }
}

async function stop() {
  server.close()
  await rm(socketDirectory, { recursive: true, force: true })
  await shutdown()
  process.exit(0)
}

// The tools the running program may call, sent by the plugin with each run.
// Runs are serialized, so one program's catalog is the only one in use.
let catalogOfCurrentRun: readonly CatalogEntry[] = []
let runQueue: Promise<void> = Promise.resolve()

process.on('SIGTERM', () => {
  void stop()
})
process.on('SIGINT', () => {
  void stop()
})
// Claude Code killed hard leaves no signal; reparenting is the tell.
setInterval(() => {
  if (process.ppid !== parentProcessId) {
    void stop()
  }
}, PARENT_CHECK_INTERVAL_MS).unref()

server.listen(socketPath, () => {
  process.stdout.write(`${READY_PREFIX}${socketPath}\n`)
})
