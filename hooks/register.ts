import type { EngineInterface, Register } from 'claude-code'
import {
  isRelayedTool,
  parseServerReply,
  RUN_INPUT_SCHEMA,
  RUN_TOOL_DESCRIPTION,
  RUN_TOOL_FULL_NAME,
  RUN_TOOL_NAME,
  runResult,
  withoutRelayedToolNames,
} from './run-tool'

// Code mode: one `run` tool replaces every tool that only moves data. The model
// writes a TypeScript program, the codemode server (codemode/server.ts, a Node
// child) evaluates it in a Secure Exec VM, and each `tools.call` in it comes
// back here to run as a real Claude Code tool call, under the session's
// permissions.
//
// The relayed tools stay registered (the bridge needs them), but they are
// deferred and their names are cut from the deferred-tools reminder, so the
// model only sees `run` and the tools it calls directly.

type ToolCallInput = Parameters<EngineInterface['tool']['call']>[0]

// One stdout line from the codemode server, after its prefix.
type ToolCallLine = { callId: string; input: ToolCallInput }

type ServerConnection =
  | { kind: 'listening'; socketPath: string }
  | { kind: 'unavailable'; reason: string }

type SettleServerConnection = (connection: ServerConnection) => void

type SpawnedOutput = ReturnType<EngineInterface['process']['spawn']>

const READY_PREFIX = 'CODEMODE_READY '
const TOOL_CALL_PREFIX = 'CODEMODE_TOOL_CALL '
const INSTALL_ERROR_CHARACTERS = 500
// Bun.Image, which zooming needs, is in Bun 1.4 on.
const MINIMUM_BUN_VERSION = [1, 4] as const

export const register: Register = (on) => {
  // Settles once: with the socket path when the server is ready, or with why it never will be.
  let settleServerConnection: SettleServerConnection = () => undefined
  const serverConnection = new Promise<ServerConnection>((resolve) => {
    settleServerConnection = resolve
  })

  on('session.start', async ($, event, next) => {
    const started = await next(event)
    await $.tool.register({
      name: RUN_TOOL_NAME,
      description: RUN_TOOL_DESCRIPTION,
      inputSchema: RUN_INPUT_SCHEMA,
    })
    $.ui.invalidate('tool.describe')
    void runCodemodeServer($, settleServerConnection)

    return started
  })

  on('tool.call', { tool: RUN_TOOL_FULL_NAME }, async ($, event, next) => {
    const [connection, catalog] = await Promise.all([serverConnection, relayedToolCatalog($)])

    if (connection.kind === 'unavailable') {
      return { deny: `codemode server unavailable: ${connection.reason}` }
    }

    try {
      const runJson = JSON.stringify({ code: event.code, inputs: event.inputs ?? {}, catalog })
      let reply = await askServer($, connection.socketPath, '/run', runJson)

      // `$.http.fetch` gives up after 30 s, so a longer run answers with its
      // id, and the plugin asks again until the reply is in.
      while (reply.pendingRunId !== undefined) {
        if (next.signal.aborted) {
          return { deny: 'run interrupted; its program may still be running' }
        }

        const waitJson = JSON.stringify({ runId: reply.pendingRunId })
        reply = await askServer($, connection.socketPath, '/wait', waitJson)
      }

      return { result: runResult(reply) }
    } catch (cause) {
      return { deny: `codemode server unavailable: ${errorText(cause)}` }
    }
  })

  // `run` in the prompt's list; every relayed tool behind ToolSearch.
  on('tool.describe', async ($, event, next) => {
    const [described, customTools] = await Promise.all([next(event), customConversationTools($)])

    if (event.tool === RUN_TOOL_FULL_NAME) {
      return { ...described, isDeferred: false }
    }

    return isRelayedTool(event.tool, customTools) ? { ...described, isDeferred: true } : described
  })

  on('prompt.attachment', { type: 'deferred_tools_delta' }, async ($, event, next) => {
    const [attached, customTools] = await Promise.all([next(event), customConversationTools($)])

    return attached.text === null
      ? attached
      : { ...attached, text: withoutRelayedToolNames(attached.text, customTools) }
  })
}

// More tools the model calls directly, outside `run`: comma separated names in
// CLAUDE_CODEMODE_CUSTOM_CONVERSATION_TOOLS, a trailing `*` matching by prefix,
// e.g. `mcp__executor__*,mcp__fff__grep`.
async function customConversationTools($: EngineInterface): Promise<readonly string[]> {
  try {
    const listed = await $.env.get('CLAUDE_CODEMODE_CUSTOM_CONVERSATION_TOOLS')

    return (listed ?? '').split(',').flatMap((entry) => entry.trim() || [])
  } catch (cause) {
    $.ui.log(`codemode: reading custom conversation tools failed: ${errorText(cause)}`)

    return []
  }
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

// POSTs a run (`/run`) or asks after one (`/wait`); the body is JSON.
async function askServer(
  $: EngineInterface,
  socketPath: string,
  path: '/run' | '/wait',
  bodyJson: string,
) {
  const response = await $.http.fetch(`http://codemode${path}`, {
    method: 'POST',
    socketPath,
    body: bodyJson,
  })

  return parseServerReply(response.text)
}

async function relayedToolCatalog($: EngineInterface) {
  const [sessionTools, customTools] = await Promise.all([$.tool.list(), customConversationTools($)])

  return sessionTools
    .filter(({ name }) => isRelayedTool(name, customTools))
    .map(({ name, description }) => ({ name, description }))
}

async function requireBun($: EngineInterface) {
  const [minimumMajor, minimumMinor] = MINIMUM_BUN_VERSION
  const needed = `the codemode server needs Bun ${minimumMajor}.${minimumMinor} or later on PATH`
  let version = ''

  try {
    const ran = await $.process.run(['bun', '--version'])
    version = ran.exitCode === 0 ? ran.stdout.trim() : ''
  } catch {
    throw new Error(needed)
  }

  const [major = 0, minor = 0] = version.split('.').map(Number)

  if (major < minimumMajor || (major === minimumMajor && minor < minimumMinor)) {
    throw new Error(`${needed}; found ${version || 'none'}`)
  }
}

// Installs the server's packages on first start, then runs it for the session's life.
async function runCodemodeServer($: EngineInterface, settle: SettleServerConnection) {
  const serverDirectory = `${$.plugin.root}/codemode`

  try {
    await requireBun($)

    if (!(await $.fs.exists(`${serverDirectory}/node_modules/secure-exec`))) {
      $.ui.toast('codemode: installing the server (first start only)')
      const installed = await $.process.run(['bun', 'install', '--frozen-lockfile'], {
        cwd: serverDirectory,
      })

      if (installed.exitCode !== 0) {
        throw new Error(`bun install failed: ${installed.stderr.slice(-INSTALL_ERROR_CHARACTERS)}`)
      }
    }

    let socketPath = ''
    const serverOutput = $.process.spawn({ argv: ['bun', 'server.ts'], cwd: serverDirectory })

    for await (const line of stdoutLines(serverOutput)) {
      // The server prints its ready line before it accepts a run, so every
      // tool call line comes after it.
      if (line.startsWith(READY_PREFIX)) {
        socketPath = line.slice(READY_PREFIX.length)
        settle({ kind: 'listening', socketPath })
      } else if (line.startsWith(TOOL_CALL_PREFIX)) {
        void answerToolCall($, socketPath, line.slice(TOOL_CALL_PREFIX.length))
      }
    }

    settle({ kind: 'unavailable', reason: 'the codemode server exited' })
  } catch (cause) {
    settle({ kind: 'unavailable', reason: errorText(cause) })
    $.ui.log(`codemode: the server did not start: ${errorText(cause)}`)
  }
}

// Whole stdout lines of a child process, however its chunks split them.
async function* stdoutLines(output: SpawnedOutput) {
  let unfinishedLine = ''

  for await (const chunk of output) {
    if (chunk.stream === 'stdout') {
      const lines = `${unfinishedLine}${chunk.text}`.split('\n')
      unfinishedLine = lines.pop() ?? ''
      yield* lines
    }
  }
}

async function runRelayedTool($: EngineInterface, { callId, input }: ToolCallLine) {
  if (!isRelayedTool(input.tool, await customConversationTools($))) {
    return {
      callId,
      outcome: 'denied',
      reason: `${input.tool} is called directly, not from code`,
    }
  }

  try {
    const called = await $.tool.call(input)

    return called.deny === undefined
      ? {
          callId,
          outcome: 'answered',
          text: called.text ?? '',
          isError: called.isError === true,
          result: called.result ?? null,
        }
      : { callId, outcome: 'denied', reason: called.deny }
  } catch (cause) {
    return { callId, outcome: 'failed', reason: errorText(cause) }
  }
}

async function answerToolCall($: EngineInterface, socketPath: string, toolCallText: string) {
  try {
    // SAFETY: the codemode server writes these lines, after zod checked the input is an object; the tool validates its own fields.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON from our own child process
    const toolCallLine = JSON.parse(toolCallText) as ToolCallLine
    const answer = await runRelayedTool($, toolCallLine)
    await $.http.fetch('http://codemode/answer', {
      method: 'POST',
      socketPath,
      body: JSON.stringify(answer),
    })
  } catch (cause) {
    $.ui.log(`codemode: answering a tool call failed: ${errorText(cause)}`, { to: 'debug' })
  }
}
