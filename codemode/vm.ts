// The Secure Exec VM the programs run in, side by side: made once, made again
// when it fails, and the host functions a program reaches `tools` through.
//
// Secure Exec fails any one host call past 30 s, whatever its limits say
// (measured), so a tool call hands the program a ticket, and the program waits
// on it in rounds shorter than that.

import { createVm, shutdown, type Vm } from 'secure-exec'
import { z } from 'zod'
import { type CatalogEntry, currentToolInputTypes, searchCatalog } from './catalog.ts'
import { type JsonValue, type ZoomRegion, zoomRegionSchema } from './image.ts'
import { callTool, type ToolInput, toolInputSchema, zoomFile } from './relay.ts'

export type VmGeneration = { vm: Vm; generation: number }

// What the host functions need of the server's runs.
export type RunLookup = {
  catalogOf: (runId: string) => readonly CatalogEntry[]
  stopRun: (runId: string, reason: string) => boolean
}

// A started tool call or zoom, settled with its value or why it failed.
type Settled = { done: true; value: JsonValue } | { done: true; error: string }

type Ticket = { runId: string; settled: Promise<Settled> }

const HOST_WAIT_MS = Number(Bun.env['CODEMODE_HOST_WAIT_MS'] ?? 20_000)
const VM_DISPOSE_WAIT_MS = 5_000

// A day: no limit in practice, and inside every timer's range. A run never
// times out; the plugin moves a long one to the background instead.
export const NO_LIMIT_MS = 86_400_000

const tickets = new Map<string, Ticket>()

// What the program sees as `tools`, over the frozen `codemode` host collection.
export function guestPrelude(runId: string) {
  return [
    `const runId = ${JSON.stringify(runId)};`,
    'const settled = async ({ ticket }) => { for (;;) { const round = await codemode.wait({ ticket }); if (round.done) { if (round.error !== undefined) throw new Error(round.error); return round.value } } };',
    'const tools = {',
    '  call: async (name, input) => settled(await codemode.call({ runId, name, input })),',
    '  search: (query) => codemode.search({ runId, query }),',
    '  zoom: async (filePath, region) => settled(await codemode.zoom({ runId, filePath, region })),',
    '  stopRun: (otherRunId) => codemode.stopRun({ runId: otherRunId }),',
    '};',
  ].join(' ')
}

// The VM runs use now, made on first use.
export function vmInUse(runs: RunLookup) {
  current ??= startVm(0, runs)

  return current
}

// Replaces a VM that failed, once however many runs saw it fail. A VM that
// cannot be made again ends the server, and the plugin starts a new one.
export async function replaceVm(failed: VmGeneration, runs: RunLookup) {
  if ((await vmInUse(runs)).generation !== failed.generation) {
    return
  }

  current = (async () => {
    await Promise.race([failed.vm.dispose().catch(() => undefined), Bun.sleep(VM_DISPOSE_WAIT_MS)])
    await shutdown().catch(() => undefined)

    return startVm(failed.generation + 1, runs)
  })()

  try {
    await current
  } catch (cause) {
    process.stderr.write(`codemode: the VM could not be made again: ${String(cause)}\n`)
    process.exit(1)
  }
}

export function forgetTickets(runId: string) {
  for (const [ticket, issued] of tickets) {
    if (issued.runId === runId) {
      tickets.delete(ticket)
    }
  }
}

// The promise's value if it settles within `ms`, else undefined.
export async function settledWithin<Value>(promise: Promise<Value>, ms: number) {
  const { promise: waited, resolve: stopWaiting } = Promise.withResolvers<undefined>()
  const waitTimer = setTimeout(stopWaiting, ms, undefined)
  const settled = await Promise.race([promise, waited])
  clearTimeout(waitTimer)

  return settled
}

async function startVm(generation: number, runs: RunLookup): Promise<VmGeneration> {
  const vm = await createVm({
    hostFunctions: {
      codemode: {
        call: {
          inputSchema: z
            .object({ runId: z.string(), name: z.string(), input: toolInputSchema })
            .describe('Start one tool call; wait on its ticket.'),
          execute: ({ runId, name, input }: { runId: string; name: string; input: ToolInput }) =>
            issueTicket(runId, () => callTool(runId, name, input)),
        },
        zoom: {
          inputSchema: z
            .object({ runId: z.string(), filePath: z.string(), region: zoomRegionSchema })
            .describe('Start zooming into part of an image file; wait on its ticket.'),
          execute: (zoom: { runId: string; filePath: string; region: ZoomRegion }) =>
            issueTicket(zoom.runId, () => zoomFile(zoom.runId, zoom.filePath, zoom.region)),
        },
        wait: {
          inputSchema: z
            .object({ ticket: z.string() })
            .describe('Wait a while on a started call: done with its value or error, or not yet.'),
          execute: ({ ticket }: { ticket: string }) => waitOnTicket(ticket),
        },
        search: {
          inputSchema: z
            .object({ runId: z.string(), query: z.string() })
            .describe('Find tools by words in their name or description.'),
          execute: async ({ runId, query }: { runId: string; query: string }) =>
            searchCatalog(runs.catalogOf(runId), await currentToolInputTypes(), query),
        },
        stopRun: {
          inputSchema: z.object({ runId: z.string() }).describe('Stop another run.'),
          execute: ({ runId }: { runId: string }) => runs.stopRun(runId, 'another run stopped it'),
        },
      },
    },
    limits: {
      hostFunctions: { defaultTimeoutMs: NO_LIMIT_MS, maxTimeoutMs: NO_LIMIT_MS },
      jsRuntime: { cpuTimeLimitMs: NO_LIMIT_MS, wallClockLimitMs: NO_LIMIT_MS },
    },
  })

  return { vm, generation }
}

function issueTicket(runId: string, work: () => Promise<JsonValue>) {
  const ticket = crypto.randomUUID()
  const settled = (async (): Promise<Settled> => {
    try {
      return { done: true, value: await work() }
    } catch (cause) {
      return { done: true, error: cause instanceof Error ? cause.message : String(cause) }
    }
  })()
  tickets.set(ticket, { runId, settled })

  return { ticket }
}

async function waitOnTicket(ticket: string) {
  const issued = tickets.get(ticket)

  if (issued === undefined) {
    return { done: true, error: `no tool call ${ticket}` } satisfies Settled
  }

  const round = await settledWithin(issued.settled, HOST_WAIT_MS)

  if (round !== undefined) {
    tickets.delete(ticket)
  }

  return round ?? { done: false }
}

let current: Promise<VmGeneration> | undefined
