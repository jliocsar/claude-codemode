// The codemode server process: Bun checked, its packages installed, spawned,
// and spawned again whenever it exits, for the session's life.

import type { EngineInterface } from 'claude-code'
import {
  errorText,
  type PendingConnection,
  pendingConnection,
  type ReadyLine,
  type ServerState,
} from './server-connection'
import { answerToolCall } from './tool-relay'

const READY_PREFIX = 'CODEMODE_READY '
const TOOL_CALL_PREFIX = 'CODEMODE_TOOL_CALL '
const INSTALL_ERROR_CHARACTERS = 500
const EXIT_REASON_CHARACTERS = 500
// Bun.Image, which zooming needs, is in Bun 1.4 on.
const MINIMUM_BUN_VERSION = [1, 4] as const
// The server is started again after it exits, unless it keeps exiting.
const RESTART_DELAY_MS = 1_000
const RESTART_WINDOW_MS = 300_000
const MAX_RESTARTS_IN_WINDOW = 5

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

// The server's packages, installed on first start.
async function installServer($: EngineInterface, serverDirectory: string) {
  if (await $.fs.exists(`${serverDirectory}/node_modules/secure-exec`)) {
    return
  }

  $.ui.toast('codemode: installing the server (first start only)')
  const installed = await $.process.run(['bun', 'install', '--frozen-lockfile'], {
    cwd: serverDirectory,
  })

  if (installed.exitCode !== 0) {
    throw new Error(`bun install failed: ${installed.stderr.slice(-INSTALL_ERROR_CHARACTERS)}`)
  }
}

// Runs the server for the session's life: started again whenever it exits
// (killed, crashed, out of memory), unless it keeps exiting.
export async function superviseServer($: EngineInterface, server: ServerState) {
  const serverDirectory = `${$.plugin.root}/codemode`

  try {
    await requireBun($)
    await installServer($, serverDirectory)
  } catch (cause) {
    server.current.settle({ kind: 'unavailable', reason: errorText(cause) })
    $.ui.log(`codemode: the server did not start: ${errorText(cause)}`)

    return
  }

  let exits: number[] = []

  for (;;) {
    const exitReason = await runServerOnce($, server.current, serverDirectory)
    const now = Date.now()
    exits = [...exits.filter((exitedAt) => now - exitedAt < RESTART_WINDOW_MS), now]
    const previous = server.current
    server.current = pendingConnection()

    if (exits.length > MAX_RESTARTS_IN_WINDOW) {
      const reason = `the codemode server exited ${exits.length} times in five minutes; last: ${exitReason}`
      server.current.settle({ kind: 'unavailable', reason })
      previous.settle(server.current.promise)
      $.ui.log(`codemode: ${reason}`)

      return
    }

    // Runs still waiting on the spawn that just ended wait on the next one.
    previous.settle(server.current.promise)
    $.ui.log(`codemode: the server exited (${exitReason}); starting it again`)
    await $.clock.sleep(RESTART_DELAY_MS)
  }
}

// One server process, from spawn to exit: settles `connection` when it is
// ready, answers its tool calls, and resolves with why it exited.
async function runServerOnce(
  $: EngineInterface,
  connection: PendingConnection,
  serverDirectory: string,
) {
  let ready: ReadyLine | undefined
  let stderrTail = ''
  let unfinishedLine = ''

  try {
    // The absolute path makes its command line this plugin's own: a
    // `pkill -f "bun server.ts"` meant for another project leaves it alone.
    const spawned = $.process.spawn({
      argv: ['bun', `${serverDirectory}/server.ts`],
      cwd: serverDirectory,
    })
    const pieces = spawned[Symbol.asyncIterator]()

    for (;;) {
      const piece = await pieces.next()

      if (piece.done === true) {
        const { code, signal } = piece.value
        const how = signal === null ? `code ${String(code)}` : `signal ${signal}`

        return stderrTail.trim() === '' ? how : `${how}: ${stderrTail.trim()}`
      }

      if (piece.value.stream === 'stderr') {
        stderrTail = `${stderrTail}${piece.value.text}`.slice(-EXIT_REASON_CHARACTERS)
        continue
      }

      const lines = `${unfinishedLine}${piece.value.text}`.split('\n')
      unfinishedLine = lines.pop() ?? ''

      for (const line of lines) {
        // The server prints its ready line before it accepts a run, so every
        // tool call line comes after it.
        if (line.startsWith(READY_PREFIX)) {
          ready = parseReadyLine(line.slice(READY_PREFIX.length))
          connection.settle({ kind: 'listening', ...ready })
        } else if (line.startsWith(TOOL_CALL_PREFIX) && ready !== undefined) {
          void answerToolCall($, ready.socketPath, line.slice(TOOL_CALL_PREFIX.length))
        }
      }
    }
  } catch (cause) {
    return errorText(cause)
  }
}

function parseReadyLine(readyText: string) {
  // SAFETY: the codemode server writes this line as JSON `{ socketPath, pid }`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON from our own child process
  return JSON.parse(readyText) as ReadyLine
}
