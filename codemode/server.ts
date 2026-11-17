// The codemode server: a Bun process the plugin spawns for the session. It
// runs the model's programs side by side in a Secure Exec VM (vm.ts) and
// relays each `tools.call` back to the plugin, which runs the real Claude Code tool.
//
// Protocol: requests to the plugin are stdout lines (the plugin reads the
// child's stream); everything else goes over a Unix socket the plugin fetches.
// Every reply over the socket is JSON: `{ text, images }` for a run.

// First: it points TMPDIR into the server's own directory before Secure Exec loads.
import { removeScratch, scratchDirectory } from './scratch.ts'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { shutdown } from 'secure-exec'
import { z } from 'zod'
import { catalogEntrySchema } from './catalog.ts'
import { warmUpChecker } from './checker.ts'
import type { ModelImage } from './image.ts'
import { type Program, type RunReply, runProgram } from './program.ts'
import { forgetRun, settleToolCall, stopRunCalls, toolAnswerSchema } from './relay.ts'
import { disposeVm, forgetTickets, type RunLookup, settledWithin, vmInUse } from './vm.ts'

// A run still going past REPLY_WAIT_MS: the plugin asks `/wait` for it again.
type PendingReply = { pendingRunId: string }

type FinishedReply = RunReply & { pendingRunId?: undefined }

type Run = Pick<Program, 'catalog' | 'code' | 'cwd'> & {
  startedAt: number
  finished: boolean
  stopper: AbortController
  reply: Promise<RunReply>
}

const READY_PREFIX = 'CODEMODE_READY '
// `$.http.fetch` gives up on a request after 30 s, so no reply waits longer.
const REPLY_WAIT_MS = Number(Bun.env['CODEMODE_REPLY_WAIT_MS'] ?? 20_000)
const PARENT_CHECK_INTERVAL_MS = 5_000
const LISTED_CODE_CHARACTERS = 80

const PICTURE_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])

const runRequestSchema = z.object({
  runId: z.string().min(1),
  code: z.string(),
  inputs: z.record(z.string(), z.json()).optional(),
  catalog: z.array(catalogEntrySchema),
  cwd: z.string().optional(),
  // CLAUDE_CODEMODE_MAX_RUN_MS, when set: the run is stopped past it.
  maxRunMs: z.number().positive().optional(),
})
const runIdRequestSchema = z.object({ runId: z.string() })
// A background run's reply travels as a prompt, where pictures cannot: they
// are saved as files, and the text names them.
const waitRequestSchema = runIdRequestSchema.extend({ picturesToFiles: z.boolean().optional() })

const runs = new Map<string, Run>()
const runLookup: RunLookup = {
  catalogOf: (runId) => runs.get(runId)?.catalog ?? [],
  cwdOf: (runId) => runs.get(runId)?.cwd ?? '/',
  stopRun: (runId, reason) => stopRun(runId, reason),
  running: () =>
    [...runs]
      .filter(([, run]) => !run.finished)
      .map(([id, run]) => ({
        id,
        seconds: Math.round((Date.now() - run.startedAt) / 1000),
        code: (run.code.trim().split('\n')[0] ?? '').slice(0, LISTED_CODE_CHARACTERS),
      })),
}
// A short path: Unix socket paths cap near 100 bytes.
const socketPath = join(scratchDirectory, 'run.sock')
const parentProcessId = process.ppid

const server = Bun.serve({
  // No idle timeout on a Unix socket: the plugin's fetch waits out a long run.
  unix: socketPath,
  routes: {
    '/run': {
      POST: async (request) => {
        const {
          inputs = {},
          cwd = '/',
          maxRunMs,
          ...program
        } = runRequestSchema.parse(await request.json())

        // The plugin names the run, so a `/run` it sends again after a lost
        // connection waits on the same program rather than starting another.
        if (!runs.has(program.runId)) {
          startRun({ ...program, inputs, cwd }, maxRunMs)
        }

        return Response.json(await replyWithin(program.runId))
      },
    },
    '/wait': {
      POST: async (request) => {
        const { runId, picturesToFiles } = waitRequestSchema.parse(await request.json())
        const reply = await replyWithin(runId)

        return Response.json(
          picturesToFiles === true && reply.pendingRunId === undefined
            ? await withPicturesSaved(runId, reply)
            : reply,
        )
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

function startRun(request: Omit<Program, 'signal'>, maxRunMs: number | undefined) {
  const { runId } = request
  const stopper = new AbortController()
  const capTimer =
    maxRunMs === undefined
      ? undefined
      : setTimeout(() => {
          stopRun(runId, `it ran past CLAUDE_CODEMODE_MAX_RUN_MS (${maxRunMs} ms)`)
        }, maxRunMs)
  const reply = (async () => {
    try {
      return await runProgram({ ...request, signal: stopper.signal }, runLookup)
    } catch (cause) {
      // Caught here: nobody may be waiting on the reply when it fails.
      return { text: `codemode server error: ${String(cause)}`, images: [] }
    } finally {
      clearTimeout(capTimer)
      const finishedRun = runs.get(runId)

      if (finishedRun !== undefined) {
        finishedRun.finished = true
      }

      forgetRun(runId)
      forgetTickets(runId)
    }
  })()
  runs.set(runId, {
    catalog: request.catalog,
    code: request.code,
    cwd: request.cwd,
    startedAt: Date.now(),
    finished: false,
    stopper,
    reply,
  })
}

// The reply with its pictures written to the scratch directory, named in the text.
async function withPicturesSaved(runId: string, { text, images }: RunReply): Promise<RunReply> {
  if (images.length === 0) {
    return { text, images }
  }

  const directory = join(scratchDirectory, 'pictures')
  await mkdir(directory, { recursive: true })
  const paths = await Promise.all(
    images.map(async ({ mediaType, base64 }: ModelImage, index) => {
      const path = join(
        directory,
        `${runId}-${index + 1}.${PICTURE_EXTENSIONS.get(mediaType) ?? 'bin'}`,
      )
      await Bun.write(path, Buffer.from(base64, 'base64'))

      return path
    }),
  )

  return {
    text: `${text}\n\nPictures, as [image N] numbers them (Read one to see it):\n${paths.join('\n')}`,
    images: [],
  }
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
async function replyWithin(runId: string): Promise<FinishedReply | PendingReply> {
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

  await disposeVm(await vmInUse(runLookup)).catch(() => undefined)
  await shutdown()
  removeScratch()
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

warmUpChecker()
await vmInUse(runLookup)
process.stdout.write(`${READY_PREFIX}${JSON.stringify({ socketPath, pid: process.pid })}\n`)
