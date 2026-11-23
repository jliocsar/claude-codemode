import type { EngineInterface, Register } from 'claude-code'
import {
  backgroundedRunText,
  finishedBackgroundRunText,
  isRelayedTool,
  RUN_INPUT_SCHEMA,
  RUN_TOOL_DESCRIPTION,
  RUN_TOOL_FULL_NAME,
  RUN_TOOL_NAME,
  runResult,
  withoutRelayedToolNames,
} from './run-tool'
import {
  askServer,
  errorText,
  pendingConnection,
  type ServerState,
  stopServerRun,
} from './server-connection'
import { superviseServer } from './server-process'
import { forgetRunAgent, rememberRunAgent } from './run-owners'
import { customConversationTools, logRunSummary } from './tool-relay'

// Code mode: one `run` tool replaces every tool that only moves data. The model
// writes a TypeScript program, the codemode server (codemode/server.ts, a Bun
// child) evaluates it in a Secure Exec VM, and each `tools.call` in it comes
// back here to run as a real Claude Code tool call, under the session's
// permissions.
//
// The relayed tools stay registered (the bridge needs them), but they are
// deferred and their names are cut from the deferred-tools reminder, so the
// model only sees `run` and the tools it calls directly.

// A run still going after this long moves to the background, as a long Bash
// command does; CLAUDE_CODEMODE_BACKGROUND_AFTER_MS sets another.
const BACKGROUND_AFTER_MS = 120_000

// Claude Code's own Code Mode runs code through this tool. With it on, two
// code tools would only split the model's attention, so codemode stands down.
const BUILT_IN_CODE_TOOL = 'REPL'

export const register: Register = (on) => {
  const server: ServerState = { current: pendingConnection() }
  // False once the session turns out to have Claude Code's own Code Mode.
  let active = true
  // Runs moved to the background, followed from `session.start`: its engine
  // lives for the session, beyond the `run` call that moved them.
  const backgroundRuns = runQueue()

  on('session.start', async ($, event, next) => {
    const started = await next(event)

    if ((await $.tool.list()).some(({ name }) => name === BUILT_IN_CODE_TOOL)) {
      active = false
      $.ui.log("Claude Code's own Code Mode is on, so codemode stays off this session")
      $.ui.invalidate('tool.describe')

      return started
    }

    await $.tool.register({
      name: RUN_TOOL_NAME,
      description: RUN_TOOL_DESCRIPTION,
      inputSchema: RUN_INPUT_SCHEMA,
    })
    $.ui.invalidate('tool.describe')
    void superviseServer($, server)
    void followBackgroundRuns($, server, backgroundRuns)

    return started
  })

  on('tool.call', { tool: RUN_TOOL_FULL_NAME }, async ($, event, next) => {
    if (event.code === undefined || event.code === null) {
      return { deny: 'run needs `code`: the body of an async TypeScript function' }
    }

    const [catalog, backgroundAfterMs, maxRunMs, maxToolCallMs, cwd] = await Promise.all([
      relayedToolCatalog($, await customConversationTools($)),
      positiveMs($.env.get('CLAUDE_CODEMODE_BACKGROUND_AFTER_MS')),
      limitMs($.env.get('CLAUDE_CODEMODE_MAX_RUN_MS')),
      limitMs($.env.get('CLAUDE_CODEMODE_MAX_TOOL_CALL_MS')),
      $.session.cwd(),
    ])
    const runId = newRunId()
    const startedAt = Date.now()
    const interrupted = whenAborted(next.signal)
    const ask = (path: '/run' | '/wait', bodyJson: string) =>
      Promise.race([askServer($, server, path, bodyJson), interrupted])
    // A subagent's run is waited out: what reaches the session from the
    // background reaches the main loop, not the subagent (run-owners.ts).
    const mayBackground = event.agentId === undefined
    rememberRunAgent(runId, event.agentId)

    try {
      const runJson = JSON.stringify({
        runId,
        code: event.code,
        inputs: event.inputs ?? {},
        catalog,
        cwd,
        maxRunMs,
        maxToolCallMs,
      })
      let reply = await ask('/run', runJson)

      // `$.http.fetch` gives up after 30 s, so a longer run answers with its
      // id, and the plugin asks again until the reply is in, or moves the run
      // to the background once it has taken long enough.
      while (reply !== 'interrupted' && reply.pendingRunId !== undefined) {
        const elapsedMs = Date.now() - startedAt

        if (mayBackground && elapsedMs >= (backgroundAfterMs ?? BACKGROUND_AFTER_MS)) {
          backgroundRuns.push(runId)

          return { result: backgroundedRunText(runId, elapsedMs) }
        }

        reply = await ask('/wait', JSON.stringify({ runId }))
      }

      if (reply === 'interrupted') {
        await stopServerRun($, server, runId)
        await logRunSummary($, runId)

        return { deny: 'run interrupted: its program was stopped' }
      }

      await logRunSummary($, runId)

      return { result: runResult(reply) }
    } catch (cause) {
      await logRunSummary($, runId)

      return { deny: `codemode server unavailable: ${errorText(cause)}` }
    } finally {
      forgetRunAgent(runId)
    }
  })

  // `run` in the prompt's list; every relayed tool behind ToolSearch.
  on('tool.describe', async ($, event, next) => {
    const [described, custom] = await Promise.all([next(event), customConversationTools($)])

    if (!active) {
      return described
    }

    if (event.tool === RUN_TOOL_FULL_NAME) {
      return { ...described, isDeferred: false }
    }

    return isRelayedTool(event.tool, custom) ? { ...described, isDeferred: true } : described
  })

  on('prompt.attachment', { type: 'deferred_tools_delta' }, async ($, event, next) => {
    const [attached, custom] = await Promise.all([next(event), customConversationTools($)])

    return !active || attached.text === null
      ? attached
      : { ...attached, text: withoutRelayedToolNames(attached.text, custom) }
  })
}

// A positive number of milliseconds from an environment variable, or undefined.
// `$.env.get` takes only a literal name, so the caller reads it.
async function positiveMs(read: Promise<string | undefined>) {
  try {
    const configured = Number(await read)

    return Number.isFinite(configured) && configured > 0 ? configured : undefined
  } catch {
    return undefined
  }
}

// A limit in milliseconds from an environment variable, 0 for none; undefined
// when unset or unreadable, for the server's default.
async function limitMs(read: Promise<string | undefined>) {
  try {
    const configured = (await read)?.trim()

    if (configured === undefined || configured === '') {
      return undefined
    }

    const ms = Number(configured)

    return Number.isFinite(ms) && ms >= 0 ? ms : undefined
  } catch {
    return undefined
  }
}

// Short, and unique enough within a session.
function newRunId() {
  return `run-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`
}

function whenAborted(signal: AbortSignal) {
  return new Promise<'interrupted'>((resolve) => {
    if (signal.aborted) {
      resolve('interrupted')
    } else {
      signal.addEventListener(
        'abort',
        () => {
          resolve('interrupted')
        },
        { once: true },
      )
    }
  })
}

// Waits out a run moved to the background, then hands the model its reply as
// a prompt of its own, the way a background command's completion arrives.
async function followBackgroundRun($: EngineInterface, server: ServerState, runId: string) {
  let text: string

  try {
    // Pictures cannot travel in a prompt: the server saves them as files.
    const waitJson = JSON.stringify({ runId, picturesToFiles: true })
    let reply = await askServer($, server, '/wait', waitJson)

    while (reply.pendingRunId !== undefined) {
      reply = await askServer($, server, '/wait', waitJson)
    }

    text = finishedBackgroundRunText(runId, reply)
  } catch (cause) {
    text = finishedBackgroundRunText(runId, {
      text: `run failed: the codemode server was lost while it ran (${errorText(cause)}). Check what it did before running it again.`,
      images: [],
    })
  }

  await logRunSummary($, runId)

  try {
    await $.prompt.submit({ text })
  } catch (cause) {
    $.ui.log(`reporting background run ${runId} failed: ${errorText(cause)}`)
  }
}

async function relayedToolCatalog($: EngineInterface, customTools: readonly string[]) {
  const sessionTools = await $.tool.list()

  return sessionTools
    .filter(({ name }) => isRelayedTool(name, customTools))
    .map(({ name, description }) => ({ name, description }))
}

// Run ids handed from the `run` hook to the session's follow-up loop.
function runQueue() {
  const waiting: string[] = []
  const takers: ((runId: string) => void)[] = []

  return {
    push: (runId: string) => {
      const taker = takers.shift()

      if (taker === undefined) {
        waiting.push(runId)
      } else {
        taker(runId)
      }
    },
    next: () => {
      const runId = waiting.shift()

      return runId === undefined
        ? new Promise<string>((resolve) => {
            takers.push(resolve)
          })
        : Promise.resolve(runId)
    },
  }
}

async function followBackgroundRuns(
  $: EngineInterface,
  server: ServerState,
  backgroundRuns: ReturnType<typeof runQueue>,
) {
  for (;;) {
    void followBackgroundRun($, server, await backgroundRuns.next())
  }
}
