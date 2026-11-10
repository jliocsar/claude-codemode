// The codemode server: a Bun process the plugin spawns for the session. It
// runs the model's programs side by side in a Secure Exec VM (vm.ts) and
// relays each `tools.call` back to the plugin, which runs the real Claude Code tool.
//
// Protocol: requests to the plugin are stdout lines (the plugin reads the
// child's stream); everything else goes over a Unix socket the plugin fetches.
// Every reply over the socket is JSON: `{ text, images }` for a run.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shutdown } from 'secure-exec'
import { z } from 'zod'
import { catalogEntrySchema } from './catalog.ts'
import { type Program, type RunReply, runProgram } from './program.ts'
import { forgetRun, settleToolCall, stopRunCalls, toolAnswerSchema } from './relay.ts'
import { forgetTickets, type RunLookup, settledWithin, vmInUse } from './vm.ts'

// A run still going past REPLY_WAIT_MS: the plugin asks `/wait` for it again.
type PendingReply = { pendingRunId: string }

type Run = Pick<Program, 'catalog'> & { stopper: AbortController; reply: Promise<RunReply> }

const READY_PREFIX = 'CODEMODE_READY '
// `$.http.fetch` gives up on a request after 30 s, so no reply waits longer.
const REPLY_WAIT_MS = Number(Bun.env['CODEMODE_REPLY_WAIT_MS'] ?? 20_000)
const PARENT_CHECK_INTERVAL_MS = 5_000

const runRequestSchema = z.object({
  runId: z.string().min(1),
  code: z.string(),
  inputs: z.record(z.string(), z.json()).optional(),
  catalog: z.array(catalogEntrySchema),
})
const runIdRequestSchema = z.object({ runId: z.string() })

const runs = new Map<string, Run>()
const runLookup: RunLookup = {
  catalogOf: (runId) => runs.get(runId)?.catalog ?? [],
  stopRun: (runId, reason) => stopRun(runId, reason),
}
// A short path in a private directory: Unix socket paths cap near 100 bytes.
const socketDirectory = await mkdtemp(join(tmpdir(), 'codemode-'))
const socketPath = join(socketDirectory, 'run.sock')
const parentProcessId = process.ppid

const server = Bun.serve({
  // No idle timeout on a Unix socket: the plugin's fetch waits out a long run.
  unix: socketPath,
  routes: {
    '/run': {
      POST: async (request) => {
        const { runId, code, inputs = {}, catalog } = runRequestSchema.parse(await request.json())

        // The plugin names the run, so a `/run` it sends again after a lost
        // connection waits on the same program rather than starting another.
        if (!runs.has(runId)) {
          startRun({ runId, code, inputs, catalog })
        }

        return Response.json(await replyWithin(runId))
      },
    },
    '/wait': {
      POST: async (request) => {
        const { runId } = runIdRequestSchema.parse(await request.json())

        return Response.json(await replyWithin(runId))
      },
    },
    '/stop': {
      POST: async (request) => {
        const { runId } = runIdRequestSchema.parse(await request.json())

        return Response.json({ stopped: stopRun(runId, 'the run was interrupted') })
      },
    },
    '/answer': {
      POST: async (request) => {
        settleToolCall(toolAnswerSchema.parse(await request.json()))

        return Response.json({})
      },
    },
    '/health': { GET: () => Response.json({ ok: true }) },
  },
  error: (cause) =>
    Response.json(
      { text: `codemode server error: ${String(cause)}`, images: [] } satisfies RunReply,
      { status: 500 },
    ),
})

function startRun(request: Omit<Program, 'signal'>) {
  const { runId } = request
  const stopper = new AbortController()
  const reply = (async () => {
    try {
      return await runProgram({ ...request, signal: stopper.signal }, runLookup)
    } catch (cause) {
      // Caught here: nobody may be waiting on the reply when it fails.
      return { text: `codemode server error: ${String(cause)}`, images: [] }
    } finally {
      forgetRun(runId)
      forgetTickets(runId)
    }
  })()
  runs.set(runId, { catalog: request.catalog, stopper, reply })
}

// Fails the run's waiting tool calls, so the program sees them throw, then
// aborts it. True when the run was still going.
function stopRun(runId: string, reason: string) {
  const run = runs.get(runId)

  if (run === undefined || run.stopper.signal.aborted) {
    return false
  }

  stopRunCalls(runId, reason)
  run.stopper.abort(reason)

  return true
}

// The run's reply once it finishes, or its id when REPLY_WAIT_MS passes first.
async function replyWithin(runId: string): Promise<RunReply | PendingReply> {
  const run = runs.get(runId)

  if (run === undefined) {
    return {
      text: `run failed: no run ${runId} here. The codemode server restarted since, and the run was lost with it: check what it did before running it again.`,
      images: [],
    }
  }

  const finishedReply = await settledWithin(run.reply, REPLY_WAIT_MS)

  if (finishedReply === undefined) {
    return { pendingRunId: runId }
  }

  runs.delete(runId)

  return finishedReply
}

async function stop() {
  await server.stop(true)
  await rm(socketDirectory, { recursive: true, force: true })
  await shutdown()
  process.exit(0)
}

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

await vmInUse(runLookup)
process.stdout.write(`${READY_PREFIX}${JSON.stringify({ socketPath, pid: process.pid })}\n`)
