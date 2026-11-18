// The Secure Exec VM the programs run in, side by side: made once, made again
// when it fails, and the host functions a program reaches `tools` through.
//
// Runs evaluate in pooled contexts (context-pool.ts).
//
// Secure Exec fails any one host call past 30 s, whatever its limits say
// (measured), so a tool call hands the program a ticket, and the program waits
// on it in rounds shorter than that.

import { type Context, createVm, shutdown, type Vm } from 'secure-exec'
import { z } from 'zod'
import { type CatalogEntry, currentToolInputTypes, searchCatalog } from './catalog.ts'
import { guestApi } from './guest.ts'
import { sidecarProcess } from './sidecar-memory.ts'
import { resolve } from 'node:path'
import { type JsonValue, type ZoomRegion, zoomRegionSchema } from './image.ts'
import { callTool, type ToolInput, toolInputSchema, zoomFile } from './relay.ts'
import {
  type EditRequest,
  editFile,
  editRequestSchema,
  type ReadRequest,
  readRequestSchema,
  readText,
  runShell,
  type ShellRequest,
  shellRequestSchema,
  type WriteRequest,
  writeFile,
  writeRequestSchema,
} from './shorthands.ts'

export type VmGeneration = { vm: Vm; generation: number; idleContexts: Context[] }

// A run still going, as `tools.runs()` lists it.
export type RunningRun = { id: string; seconds: number; code: string }

// What the host functions need of the server's runs.
export type RunLookup = {
  catalogOf: (runId: string) => readonly CatalogEntry[]
  // The session's directory, where the run's relative paths start.
  cwdOf: (runId: string) => string
  stopRun: (runId: string, reason: string) => boolean
  running: () => RunningRun[]
}

// A started tool call or zoom, settled with its value or why it failed.
type Settled = { done: true; value: JsonValue } | { done: true; error: string }

type Ticket = { runId: string; settled: Promise<Settled> }

const HOST_WAIT_MS = Number(Bun.env['CODEMODE_HOST_WAIT_MS'] ?? 20_000)
const VM_DISPOSE_WAIT_MS = 5_000
// A sidecar holding more than this is made again once no run is going.
const SIDECAR_RECYCLE_BYTES = Number(Bun.env['CODEMODE_SIDECAR_RECYCLE_MB'] ?? 1024) * 1024 * 1024

// A day: no limit in practice, and inside every timer's range. A run never
// times out; the plugin moves a long one to the background instead.
export const NO_LIMIT_MS = 86_400_000

const tickets = new Map<string, Ticket>()
// `keep`'s values by key, here on the host so they outlive a replaced VM.
const kept = new Map<string, JsonValue>()
const jsonValueSchema = z.json()

// The program's globals, from guest.ts's source, bound to its run.
export function guestPrelude(runId: string) {
  return `const { tools, $, read, write, edit, keep } = (${guestApi.toString()})(${JSON.stringify(runId)});`
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

  await renewVm(failed, runs)
}

// Makes the VM again in a new sidecar when the sidecar holds more than
// SIDECAR_RECYCLE_BYTES, and only while no run is going: a run's evaluate and
// its tool calls' tickets would go with the old one. `keep` and the runs live
// here on the host, so they stay.
export async function recycleLargeSidecar(runs: RunLookup) {
  const checked = current

  if (checked === undefined || runs.running().length > 0) {
    return
  }

  const [vmUsed, sidecar] = await Promise.all([checked, sidecarProcess()])
  const residentBytes = sidecar?.residentBytes

  // Checked again after the wait, with nothing awaited before renewing: a run
  // that started meanwhile keeps the VM, and another recycle already made one.
  if (
    residentBytes === undefined ||
    residentBytes < SIDECAR_RECYCLE_BYTES ||
    runs.running().length > 0 ||
    current !== checked
  ) {
    return
  }

  await renewVm(vmUsed, runs)
}

// The next VM, in a new sidecar. `current` points at it at once, so a run
// that starts meanwhile waits for it rather than taking the old one.
async function renewVm(old: VmGeneration, runs: RunLookup) {
  current = (async () => {
    await Promise.race([disposeVm(old), Bun.sleep(VM_DISPOSE_WAIT_MS)])
    await shutdown().catch(() => undefined)

    return startVm(old.generation + 1, runs)
  })()

  try {
    await current
  } catch (cause) {
    process.stderr.write(`codemode: the VM could not be made again: ${String(cause)}\n`)
    process.exit(1)
  }
}

// Contexts first: a VM disposed with one still open logs a forced finalize
// (measured).
export async function disposeVm(vmUsed: VmGeneration) {
  const idle = vmUsed.idleContexts.splice(0)
  await Promise.all(idle.map((context) => context.dispose().catch(() => undefined)))
  await vmUsed.vm.dispose().catch(() => undefined)
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
          execute: ({
            runId,
            filePath,
            region,
          }: {
            runId: string
            filePath: string
            region: ZoomRegion
          }) =>
            issueTicket(runId, () => zoomFile(runId, resolve(runs.cwdOf(runId), filePath), region)),
        },
        shell: {
          inputSchema: shellRequestSchema.describe('Start a `$` command; wait on its ticket.'),
          execute: (request: ShellRequest) =>
            issueTicket(request.runId, () => runShell(request, runs.cwdOf(request.runId))),
        },
        read: {
          inputSchema: readRequestSchema.describe(
            "Start reading a file's text; wait on its ticket.",
          ),
          execute: (request: ReadRequest) =>
            issueTicket(request.runId, () => readText(request, runs.cwdOf(request.runId))),
        },
        write: {
          inputSchema: writeRequestSchema.describe('Start writing a file; wait on its ticket.'),
          execute: (request: WriteRequest) =>
            issueTicket(request.runId, () => writeFile(request, runs.cwdOf(request.runId))),
        },
        edit: {
          inputSchema: editRequestSchema.describe('Start editing a file; wait on its ticket.'),
          execute: (request: EditRequest) =>
            issueTicket(request.runId, () => editFile(request, runs.cwdOf(request.runId))),
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
        runs: {
          inputSchema: z.object({}).describe('The runs still going.'),
          execute: () => runs.running(),
        },
        stopRun: {
          inputSchema: z.object({ runId: z.string() }).describe('Stop another run.'),
          execute: ({ runId }: { runId: string }) => runs.stopRun(runId, 'another run stopped it'),
        },
        keepGet: {
          inputSchema: z.object({ key: z.string() }).describe('A kept value.'),
          execute: ({ key }: { key: string }) => ({
            found: kept.has(key),
            value: kept.get(key) ?? null,
          }),
        },
        keepSet: {
          inputSchema: z
            .object({ key: z.string(), json: z.string() })
            .describe('Keep a value, sent as JSON text, for later runs.'),
          execute: ({ key, json }: { key: string; json: string }) => {
            kept.set(key, jsonValueSchema.parse(JSON.parse(json)))

            return null
          },
        },
        keepDelete: {
          inputSchema: z.object({ key: z.string() }).describe('Forget a kept value.'),
          execute: ({ key }: { key: string }) => kept.delete(key),
        },
      },
    },
    limits: {
      hostFunctions: { defaultTimeoutMs: NO_LIMIT_MS, maxTimeoutMs: NO_LIMIT_MS },
      jsRuntime: { cpuTimeLimitMs: NO_LIMIT_MS, wallClockLimitMs: NO_LIMIT_MS },
    },
  })

  return { vm, generation, idleContexts: [] }
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
