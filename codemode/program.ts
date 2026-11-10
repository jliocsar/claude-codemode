// One program, from type check to reply: what the model reads of it, and the
// VM made again when it was the VM, not the program, that failed.

import type { Vm } from 'secure-exec'
import { z } from 'zod'
import { buildTypeCheckPrelude, type CatalogEntry, currentToolInputTypes } from './catalog.ts'
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
  signal: AbortSignal
}

type RunResponse =
  | { ok: true; value: JsonValue; stdout: string }
  | { ok: false; feedback: string; stdout: string }

type SucceededRun = Extract<RunResponse, { ok: true }>

// What a failed VM looks like from outside, beside a call that throws.
const VM_FAILURE =
  /SidecarProcessExited|sidecar process exited|ERR_AGENTOS_REQUEST_TASK_PANIC|ERR_AGENTOS_VM/u

const DISK_FULL = /No space left on device|ENOSPC/u
const MAY_HAVE_RUN = 'It may have partly run: check what it did before running it again.'

const jsonValueSchema = z.json()

// What the model reads: the returned value alone (a string as is), its
// pictures as `[image N]` with the images after, or why the run failed; then
// any console output.
export async function runProgram(program: Program, runs: RunLookup): Promise<RunReply> {
  const response = await respond(program, runs)
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

// Why the VM could not check or run the program, plainly when the disk is full.
function vmFailureFeedback(stage: string, cause: string) {
  return DISK_FULL.test(cause)
    ? `the disk is full, so the VM could not ${stage}: ${cause}`
    : `the VM failed to ${stage} and was restarted: ${cause}`
}

async function typeErrors(vm: Vm, { code, catalog, signal }: Program) {
  const typeCheckPrelude = buildTypeCheckPrelude(catalog, await currentToolInputTypes())
  const checked = await vm.typescript.check(`${typeCheckPrelude}${code}\n}\nexport {}\n`, {
    signal,
  })

  if (checked.outcome !== 'succeeded') {
    const output = `${checked.stderr ?? ''}${checked.stdout ?? ''}`.trim()

    throw new Error(output === '' ? checked.error.message : `${checked.error.message}: ${output}`)
  }

  const typeCheckPreludeLineCount = typeCheckPrelude.split('\n').length - 1

  return checked.diagnostics
    .filter((diagnostic) => diagnostic.category === 'error')
    .map(
      (diagnostic) =>
        `line ${(diagnostic.line ?? 0) - typeCheckPreludeLineCount}: TS${diagnostic.code} ${diagnostic.message}`,
    )
}

async function respond(program: Program, runs: RunLookup): Promise<RunResponse> {
  const vmUsed = await vmInUse(runs)
  let errors: string[]

  try {
    errors = await typeErrors(vmUsed.vm, program)
  } catch (cause) {
    const message = String(cause)
    await replaceVm(vmUsed, runs)

    return { ok: false, feedback: vmFailureFeedback('type-check the program', message), stdout: '' }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      feedback: `nothing ran, the code has type errors:\n${errors.join('\n')}`,
      stdout: '',
    }
  }

  return evaluate(vmUsed, program, runs)
}

async function evaluate(
  vmUsed: VmGeneration,
  { runId, code, inputs, signal }: Program,
  runs: RunLookup,
): Promise<RunResponse> {
  let ran: Awaited<ReturnType<Vm['typescript']['evaluate']>>

  try {
    ran = await vmUsed.vm.typescript.evaluate(
      `(async () => {\n${guestPrelude(runId)}\n${code}\n})()`,
      { inputs, timeoutMs: NO_LIMIT_MS, signal, output: { capture: 'all' } },
    )
  } catch (cause) {
    await replaceVm(vmUsed, runs)

    return {
      ok: false,
      feedback: `${vmFailureFeedback('run the program', String(cause))}. ${MAY_HAVE_RUN}`,
      stdout: '',
    }
  }

  const stdout = ran.stdout ?? ''

  if (ran.outcome === 'succeeded') {
    // As JSON, the way the model reads it: `undefined` and functions drop out.
    const value = jsonValueSchema.parse(JSON.parse(JSON.stringify(ran.value ?? null)))

    return { ok: true, value, stdout }
  }

  if (ran.outcome === 'cancelled') {
    return { ok: false, feedback: `stopped: ${String(signal.reason)}`, stdout }
  }

  const stderr = ran.stderr ?? ''
  const failure = stderr === '' ? ran.error.message : stderr

  if (!VM_FAILURE.test(failure)) {
    return { ok: false, feedback: failure, stdout }
  }

  await replaceVm(vmUsed, runs)

  return {
    ok: false,
    feedback: `${vmFailureFeedback('run the program', failure)}. ${MAY_HAVE_RUN}`,
    stdout,
  }
}
