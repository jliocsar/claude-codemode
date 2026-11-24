// One program, from type check to reply: what the model reads of it, and the
// VM made again when it was the VM, not the program, that failed.

import type { Context } from 'secure-exec'
import { z } from 'zod'
import { buildTypeCheckPrelude, type CatalogEntry, currentToolInputTypes } from './catalog.ts'
import { releaseContext, takeContext } from './context-pool.ts'
import { stripTypes, typeErrors, withLastExpressionReturned } from './checker.ts'
import { type JsonValue, type ModelImage, takeOutImages } from './image.ts'
import {
  guestPrelude,
  NO_LIMIT_MS,
  replaceVm,
  type RunLookup,
  type VmGeneration,
  vmInUse,
} from './vm.ts'

// What the model reads: `text`, then each image in `images` as an image block.
export type RunReply = { text: string; images: ModelImage[] }

export type Program = {
  runId: string
  code: string
  inputs: Record<string, JsonValue>
  catalog: readonly CatalogEntry[]
  // The session's directory: relative paths in `read`, `write`, `edit` and `$`'s `.cwd` start here.
  cwd: string
  signal: AbortSignal
}

type RunResponse =
  | { ok: true; value: JsonValue; stdout: string }
  | { ok: false; feedback: string; stdout: string }

type SucceededRun = Extract<RunResponse, { ok: true }>

type Evaluation = Awaited<ReturnType<Context['evaluate']>>

// What a failed VM looks like from outside, beside a call that throws.
const VM_FAILURE =
  /SidecarProcessExited|sidecar process exited|ERR_AGENTOS_REQUEST_TASK_PANIC|ERR_AGENTOS_VM/u

const DISK_FULL = /No space left on device|ENOSPC/u

// Secure Exec prints this on every evaluate in a context used before: it
// defines the host functions again and finds the first ones there. Noise, and
// read first it hid the real failure (seen).
const HOST_GROUP_NOTICE =
  /^agentos: host function group "[^"]+" was not defined because globalThis\.\S+ already exists\n?/gmu

// Secure Exec gave up on an evaluate whose program was still going: with runs
// side by side, one ended early on a missing result file while its program
// kept running in the context, and the next run there never finished
// (measured). That context is lost, not the run's program at fault.
const LOST_EVALUATION = /no structured result|ERR_LATE_STREAM_EVENT/u
const MAY_HAVE_RUN = 'It may have partly run: check what it did before running it again.'

const jsonValueSchema = z.json()

// What the model reads: the returned value alone (a string as is), its
// pictures as `[image N]` with the images after, or why the run failed; then
// any console output. With no value, the console output alone.
export async function runProgram(program: Program, runs: RunLookup): Promise<RunReply> {
  const response = await respond(program, runs)
  const stdout = response.stdout.trimEnd()

  if (response.ok && response.value === null) {
    return { text: stdout === '' ? '(no value)' : stdout, images: [] }
  }

  const { text, images } = response.ok
    ? returnedValueReply(response)
    : { text: `run failed: ${response.feedback}`, images: [] }

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

// Why the VM could not run the program, plainly when the disk is full.
function vmFailureFeedback(cause: string) {
  return DISK_FULL.test(cause)
    ? `the disk is full, so the VM could not run the program: ${cause}`
    : `the VM failed to run the program and was restarted: ${cause}. ${MAY_HAVE_RUN}`
}

async function respond(program: Program, runs: RunLookup): Promise<RunResponse> {
  const code = withLastExpressionReturned(program.code)
  let errors: string[]

  try {
    const prelude = buildTypeCheckPrelude(program.catalog, await currentToolInputTypes())
    errors = typeErrors(prelude, code)
  } catch (cause) {
    return { ok: false, feedback: `the type check failed: ${String(cause)}`, stdout: '' }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      feedback: `nothing ran, the code has type errors:\n${errors.join('\n')}`,
      stdout: '',
    }
  }

  return evaluate(await vmInUse(runs), { ...program, code }, runs)
}

// The program's value as JSON, the way the model reads it: Secure Exec fails
// an `undefined` value (measured), so no value reads as `null`, and
// functions drop out as JSON.stringify drops them.
function guestSource({ runId, code }: Program) {
  return stripTypes(
    `(async () => {\n${guestPrelude(runId)}\n${code}\n})().then((value) => JSON.parse(JSON.stringify(value) ?? 'null'))`,
  )
}

async function evaluate(
  vmUsed: VmGeneration,
  program: Program,
  runs: RunLookup,
): Promise<RunResponse> {
  const { inputs, signal } = program
  let context: Context | undefined
  let ran: Evaluation

  try {
    context = await takeContext(vmUsed)
    ran = await context.evaluate(guestSource(program), {
      inputs,
      timeoutMs: NO_LIMIT_MS,
      signal,
      output: { capture: 'all' },
    })
  } catch (cause) {
    await context?.dispose().catch(() => undefined)
    await replaceVm(vmUsed, runs)

    return { ok: false, feedback: vmFailureFeedback(String(cause)), stdout: '' }
  }

  // Only a context whose evaluate succeeded goes back to the pool: one that
  // failed may still hold its program, and a run handed it never finishes.
  await releaseContext(vmUsed, context, ran.outcome === 'succeeded')
  const stdout = ran.stdout ?? ''

  if (ran.outcome === 'succeeded') {
    const value = jsonValueSchema.parse(ran.value ?? null)

    return { ok: true, value, stdout }
  }

  if (ran.outcome === 'cancelled') {
    return { ok: false, feedback: `stopped: ${String(signal.reason)}`, stdout }
  }

  const stderr = (ran.stderr ?? '').replace(HOST_GROUP_NOTICE, '').trim()
  const failure = stderr === '' ? ran.error.message : stderr

  if (LOST_EVALUATION.test(`${ran.error.message}\n${failure}`)) {
    return {
      ok: false,
      feedback: `the VM lost track of the run before it ended (${ran.error.message}). ${MAY_HAVE_RUN}`,
      stdout,
    }
  }

  if (!VM_FAILURE.test(failure)) {
    return { ok: false, feedback: failure, stdout }
  }

  await replaceVm(vmUsed, runs)

  return { ok: false, feedback: vmFailureFeedback(failure), stdout }
}
