// The contexts runs evaluate in. Each run takes one of its own from a pool and
// gives it back after: a warm context evaluates in ~9 ms against ~95 ms for a
// fresh one (measured). They are not reset between runs, since a reset context
// is cold again, but one is retired after CONTEXT_MAX_RUNS: each evaluate
// leaves ~0.3 MB in the sidecar until its context is disposed, 1.9 GB over a
// long session (measured).

import type { Context } from 'secure-exec'
import type { VmGeneration } from './vm.ts'

// Idle contexts kept past this many are disposed.
const MAX_IDLE_CONTEXTS = 4
// Runs a context evaluates before it is disposed: one cold start (~95 ms) in
// fifty, and at most ~60 MB held across a full pool.
const CONTEXT_MAX_RUNS = Number(Bun.env['CODEMODE_CONTEXT_MAX_RUNS'] ?? 50)

// The runs each context has evaluated.
const contextRuns = new WeakMap<Context, number>()

// An idle context, or a new one when every one is busy.
export function takeContext(vmUsed: VmGeneration) {
  const idle = vmUsed.idleContexts.pop()

  return idle === undefined ? vmUsed.vm.createContext() : Promise.resolve(idle)
}

// A context back in the pool after its run, or disposed when the run was
// stopped (it may have been mid host call), it has run its share, or the pool
// is full.
export async function releaseContext(vmUsed: VmGeneration, context: Context, reusable: boolean) {
  const evaluated = (contextRuns.get(context) ?? 0) + 1
  contextRuns.set(context, evaluated)

  if (reusable && evaluated < CONTEXT_MAX_RUNS && vmUsed.idleContexts.length < MAX_IDLE_CONTEXTS) {
    vmUsed.idleContexts.push(context)
  } else {
    await context.dispose().catch(() => undefined)
  }
}
