// The sidecar's memory over many runs, on real servers of their own: the
// shared one in spec-harness.ts keeps the default limits, and these set them.
// Nothing here stands in for the VM or the sidecar.

import { expect, test } from 'bun:test'
import { z } from 'zod'
import { type SidecarProcess, sidecarProcess } from './sidecar-memory.ts'

const READY_PREFIX = 'CODEMODE_READY '
const MB = 1024 * 1024
const LANES = 4
const WARM_UP_RUNS_PER_LANE = 60
const MEASURED_RUNS_PER_LANE = 100
// Without retiring contexts, 400 runs held ~120 MB more (measured).
const ALLOWED_GROWTH_BYTES = 40 * MB
const RECYCLE_WAIT_MS = 15_000
const SLOW_RUN_MS = 5_000

const readyLineSchema = z.object({ socketPath: z.string() })
const replySchema = z.union([
  z.object({ text: z.string(), pendingRunId: z.undefined().optional() }),
  z.object({ pendingRunId: z.string() }),
])

type TestServer = Awaited<ReturnType<typeof startServer>>

async function startServer(env: Record<string, string>) {
  const child = Bun.spawn(['bun', 'server.ts'], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'ignore',
    env: { ...Bun.env, ...env },
  })
  const socketPath = await readySocketPath(child.stdout)

  const post = async (path: '/run' | '/wait', bodyJson: string) => {
    const response = await fetch(`http://codemode${path}`, {
      unix: socketPath,
      method: 'POST',
      body: bodyJson,
    })

    return replySchema.parse(await response.json())
  }

  // The run's text once it is done, asking `/wait` while it is going.
  const run = async (code: string) => {
    let reply = await post(
      '/run',
      JSON.stringify({ runId: crypto.randomUUID(), code, catalog: [] }),
    )

    while (reply.pendingRunId !== undefined) {
      reply = await post('/wait', JSON.stringify({ runId: reply.pendingRunId }))
    }

    return reply.text
  }

  return { child, run, sidecar: () => sidecarProcess(child.pid) }
}

// The ready line's socket path; the rest of stdout is read and dropped.
function readySocketPath(stdout: ReadableStream<Uint8Array<ArrayBuffer>>) {
  const { promise, resolve } = Promise.withResolvers<string>()

  void (async () => {
    let text = ''

    for await (const chunk of stdout.pipeThrough(new TextDecoderStream())) {
      text = `${text}${chunk}`.slice(-10_000)
      const line = text.split('\n').find((candidate) => candidate.startsWith(READY_PREFIX))

      if (line !== undefined) {
        resolve(readyLineSchema.parse(JSON.parse(line.slice(READY_PREFIX.length))).socketPath)
      }
    }
  })()

  return promise
}

async function runsSideBySide(server: TestServer, runsPerLane: number) {
  await Promise.all(
    [...Array.from({ length: LANES }).keys()].map(async (lane) => {
      for (let index = 0; index < runsPerLane; index += 1) {
        expect(await server.run(`${lane} + ${index}`)).toBe(String(lane + index))
      }
    }),
  )
}

// The sidecar, waiting for the server to make its VM on first use.
async function currentSidecar(server: TestServer) {
  const deadline = Date.now() + RECYCLE_WAIT_MS

  while (Date.now() < deadline) {
    const sidecar = await server.sidecar()

    if (sidecar !== undefined) {
      return sidecar
    }

    await Bun.sleep(100)
  }

  throw new Error('the server made no sidecar process')
}

// The sidecar once it is another process than `previous`, or undefined if it
// stays the same one for RECYCLE_WAIT_MS.
async function sidecarAfter(server: TestServer, previous: SidecarProcess) {
  const deadline = Date.now() + RECYCLE_WAIT_MS

  while (Date.now() < deadline) {
    const sidecar = await server.sidecar()

    if (sidecar !== undefined && sidecar.pid !== previous.pid) {
      return sidecar
    }

    await Bun.sleep(200)
  }

  return undefined
}

test(
  "the sidecar's memory stays flat over hundreds of runs",
  async () => {
    const server = await startServer({})

    try {
      await runsSideBySide(server, WARM_UP_RUNS_PER_LANE)
      const before = await currentSidecar(server)
      await runsSideBySide(server, MEASURED_RUNS_PER_LANE)
      const after = await currentSidecar(server)

      expect(after.pid).toBe(before.pid)
      expect(after.residentBytes - before.residentBytes).toBeLessThan(ALLOWED_GROWTH_BYTES)
    } finally {
      server.child.kill('SIGTERM')
      await server.child.exited
    }
  },
  { timeout: 300_000 },
)

test(
  'a sidecar past its limit is made again once no run is going, keep and all',
  async () => {
    const server = await startServer({
      CODEMODE_SIDECAR_RECYCLE_MB: '1',
      CODEMODE_REPLY_WAIT_MS: '100',
    })

    try {
      // A slow run holds the sidecar: a quick one finishing beside it does not recycle it.
      const slow = server.run(
        `keep.set('answer', 42); await new Promise((resolve) => setTimeout(resolve, ${SLOW_RUN_MS})); 'slow'`,
      )
      const held = await currentSidecar(server)
      expect(await server.run('1 + 1')).toBe('2')
      await Bun.sleep(1_000)
      expect((await currentSidecar(server)).pid).toBe(held.pid)

      expect(await slow).toBe('slow')
      expect(await sidecarAfter(server, held)).toBeDefined()
      expect(await server.run("keep.get('answer')")).toBe('42')
    } finally {
      server.child.kill('SIGTERM')
      await server.child.exited
    }
  },
  { timeout: 120_000 },
)
