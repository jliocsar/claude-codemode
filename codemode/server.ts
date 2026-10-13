// The codemode server: a Bun process the plugin spawns once per session. It
// owns one Secure Exec VM, runs the model's programs in it, and relays each
// `tools.call` back to the plugin, which runs the real Claude Code tool.
//
// Protocol: requests to the plugin are stdout lines (the plugin reads the
// child's stream); everything else goes over a Unix socket the plugin fetches.
// Every reply over the socket is JSON: `{ text, images }` for a run.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVm, shutdown } from 'secure-exec'
import { z } from 'zod'
import {
  buildTypeCheckPrelude,
  type CatalogEntry,
  catalogEntrySchema,
  loadToolInputTypes,
  searchCatalog,
} from './catalog.ts'
import {
  type JsonValue,
  type ModelImage,
  takeOutImages,
  type ZoomRegion,
  zoomRegionSchema,
} from './image.ts'
import {
  askPluginToRunTool,
  settleToolCall,
  toolAnswerSchema,
  type ToolInput,
  toolInputSchema,
  zoomFile,
} from './relay.ts'

type RunResponse =
  | { ok: true; value: JsonValue; stdout: string }
  | { ok: false; feedback: string; stdout: string }

type SucceededRun = Extract<RunResponse, { ok: true }>

// What the model reads: `text`, then each image in `images` as an image block.
type RunReply = { text: string; images: ModelImage[] }

// A run still going past REPLY_WAIT_MS: the plugin asks `/wait` for it again.
type PendingReply = { pendingRunId: string }

const READY_PREFIX = 'CODEMODE_READY '

// Bash's own max timeout, so one long Bash call fits in one host call.
const HOST_FUNCTION_TIMEOUT_MS = 600_000
// A knob: the whole program, which may chain several long calls.
const RUN_TIMEOUT_MS = 1_800_000
// `$.http.fetch` gives up on a request after 30 s, so no reply waits longer.
const REPLY_WAIT_MS = Number(Bun.env['CODEMODE_REPLY_WAIT_MS'] ?? 20_000)
const PARENT_CHECK_INTERVAL_MS = 5_000

// What the program sees as `tools`, over the frozen `codemode` host collection.
const GUEST_PRELUDE =
  'const tools = { call: (name, input) => codemode.call({ name, input }), search: (query) => codemode.search({ query }), zoom: (filePath, region) => codemode.zoom({ filePath, region }) };'

const runRequestSchema = z.object({
  code: z.string(),
  inputs: z.record(z.string(), z.json()).optional(),
  catalog: z.array(catalogEntrySchema),
})
const waitRequestSchema = z.object({ runId: z.string() })
const jsonValueSchema = z.json()

type RunInputs = NonNullable<z.infer<typeof runRequestSchema>['inputs']>

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
      zoom: {
        inputSchema: z
          .object({ filePath: z.string(), region: zoomRegionSchema })
          .describe('Zoom into part of an image file at its own pixels.'),
        execute: ({ filePath, region }: { filePath: string; region: ZoomRegion }) =>
          zoomFile(filePath, region),
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

// A short path in a private directory: Unix socket paths cap near 100 bytes.
const socketDirectory = await mkdtemp(join(tmpdir(), 'codemode-'))
const socketPath = join(socketDirectory, 'run.sock')
const parentProcessId = process.ppid
// Each run's reply by id, from `/run` until a reply hands it over.
const runReplies = new Map<string, Promise<RunReply>>()

const server = Bun.serve({
  // No idle timeout on a Unix socket: the plugin's fetch waits out a long run.
  unix: socketPath,
  routes: {
    '/run': {
      POST: async (request) => {
        const { code, inputs = {}, catalog } = runRequestSchema.parse(await request.json())
        const runId = crypto.randomUUID()
        runReplies.set(runId, runAfterPreviousRuns(code, inputs, catalog))

        return Response.json(await replyWithin(runId))
      },
    },
    '/wait': {
      POST: async (request) => {
        const { runId } = waitRequestSchema.parse(await request.json())

        return Response.json(await replyWithin(runId))
      },
    },
    '/answer': {
      POST: async (request) => {
        settleToolCall(toolAnswerSchema.parse(await request.json()))

        return Response.json({})
      },
    },
  },
  error: (cause) =>
    Response.json(
      { text: `codemode server error: ${String(cause)}`, images: [] } satisfies RunReply,
      { status: 500 },
    ),
})

// What the model reads: the returned value alone (a string as is), its
// pictures as `[image N]` with the images after, or why the run failed; then
// any console output.
function runReply(response: RunResponse): RunReply {
  const { text, images } = response.ok
    ? returnedValueReply(response)
    : { text: `run failed: ${response.feedback}`, images: [] }
  const stdout = response.stdout.trimEnd()

  return { text: stdout === '' ? text : `${text}\n\nstdout:\n${stdout}`, images }
}

function returnedValueReply(response: SucceededRun): RunReply {
  const { value, images } = takeOutImages(response.value)
  const returnedString = z.string().safeParse(value)

  return {
    text: returnedString.success ? returnedString.data : JSON.stringify(value),
    images,
  }
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
    // As JSON, the way the model reads it: `undefined` and functions drop out.
    const value = jsonValueSchema.parse(JSON.parse(JSON.stringify(ran.value ?? null)))

    return { ok: true, value, stdout: ran.stdout ?? '' }
  }

  const stderr = ran.stderr ?? ''

  return {
    ok: false,
    feedback: stderr === '' ? ran.error.message : stderr,
    stdout: ran.stdout ?? '',
  }
}

// The run's reply once it finishes, or its id when REPLY_WAIT_MS passes first.
async function replyWithin(runId: string): Promise<RunReply | PendingReply> {
  const reply = runReplies.get(runId)

  if (reply === undefined) {
    return { text: `codemode server error: no run ${runId}`, images: [] }
  }

  const { promise: waited, resolve: stopWaiting } = Promise.withResolvers<undefined>()
  const waitTimer = setTimeout(stopWaiting, REPLY_WAIT_MS, undefined)
  const finishedReply = await Promise.race([reply, waited])
  clearTimeout(waitTimer)

  if (finishedReply === undefined) {
    return { pendingRunId: runId }
  }

  runReplies.delete(runId)

  return finishedReply
}

// One program at a time: the VM is shared, and parallel runs would interleave.
async function runAfterPreviousRuns(
  code: string,
  inputs: RunInputs,
  catalog: readonly CatalogEntry[],
): Promise<RunReply> {
  const previousRunsFinished = runQueue
  const { promise: thisRunFinished, resolve: finishThisRun } = Promise.withResolvers<void>()
  runQueue = thisRunFinished
  await previousRunsFinished

  try {
    return runReply(await runProgram(code, inputs, catalog))
  } catch (cause) {
    // Caught here: nobody may be waiting on the reply when it fails.
    return { text: `codemode server error: ${String(cause)}`, images: [] }
  } finally {
    finishThisRun()
  }
}

async function stop() {
  await server.stop(true)
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

process.stdout.write(`${READY_PREFIX}${socketPath}\n`)
