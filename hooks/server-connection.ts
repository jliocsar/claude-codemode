// The plugin's side of the codemode server's socket: the server as runs find
// it, asking it, and replacing one that stopped answering.

import type { EngineInterface } from 'claude-code'
import { parseServerReply, type ServerReply } from './run-tool'

// The server's ready line, after its prefix.
export type ReadyLine = { socketPath: string; pid: number }

export type ServerConnection =
  | ({ kind: 'listening' } & ReadyLine)
  | { kind: 'unavailable'; reason: string }

type Listening = Extract<ServerConnection, { kind: 'listening' }>

// The server as runs find it: settles once a spawn is ready or will never be,
// and is replaced by the next spawn's when the server exits.
export type PendingConnection = {
  promise: Promise<ServerConnection>
  settle: (connection: ServerConnection | Promise<ServerConnection>) => void
}

export type ServerState = { current: PendingConnection }

// A killed server gets this long to stop on its own before SIGKILL.
const KILL_GRACE_MS = 3_000
// How long a run waits for a server started again before it gives up.
const NEW_SERVER_WAIT_MS = 30_000
const NEW_SERVER_POLL_MS = 250

export function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

export function pendingConnection(): PendingConnection {
  let settle: PendingConnection['settle'] = () => undefined
  const promise = new Promise<ServerConnection>((resolve) => {
    settle = resolve
  })

  return { promise, settle }
}

async function listeningServer(server: ServerState) {
  const connection = await server.current.promise

  if (connection.kind === 'unavailable') {
    throw new Error(connection.reason)
  }

  return connection
}

async function fetchServer(
  $: EngineInterface,
  connection: Listening,
  path: string,
  bodyJson: string,
) {
  const response = await $.http.fetch(`http://codemode${path}`, {
    method: 'POST',
    socketPath: connection.socketPath,
    body: bodyJson,
  })

  return parseServerReply(response.text)
}

// POSTs a run (`/run`) or asks after one (`/wait`). A server that fails to
// answer is checked, killed when it no longer answers at all, and asked again
// once: the plugin names each run, so a `/run` sent twice to one server starts
// one program. A new server never gets the `/run` again: the program may have
// run, and may be what ended the old one.
export async function askServer(
  $: EngineInterface,
  server: ServerState,
  path: '/run' | '/wait',
  bodyJson: string,
): Promise<ServerReply> {
  const connection = await listeningServer(server)

  try {
    return await fetchServer($, connection, path, bodyJson)
  } catch (cause) {
    $.ui.log(`codemode: ${path} failed (${errorText(cause)}); checking the server`, { to: 'debug' })
    const recovered = await recoverServer($, server, connection)

    if (path === '/run' && recovered.pid !== connection.pid) {
      return {
        text: `run failed: the codemode server stopped while the run started (${errorText(cause)}). It was restarted, but the program may have run: check what it did before running it again.`,
        images: [],
      }
    }

    return fetchServer($, recovered, path, bodyJson)
  }
}

// The server that should answer now: this one when it still does, else a new one.
async function recoverServer($: EngineInterface, server: ServerState, failed: Listening) {
  try {
    const health = await $.http.fetch('http://codemode/health', { socketPath: failed.socketPath })

    if (health.ok) {
      return failed
    }
  } catch {}

  await killServer($, server, failed)

  return nextServer($, server, failed)
}

// Waits for a server other than `failed` to be listening.
async function nextServer($: EngineInterface, server: ServerState, failed: Listening) {
  const giveUpAt = Date.now() + NEW_SERVER_WAIT_MS

  while (Date.now() < giveUpAt) {
    const connection = await listeningServer(server)

    if (connection.pid !== failed.pid) {
      return connection
    }

    await $.clock.sleep(NEW_SERVER_POLL_MS)
  }

  throw new Error('the codemode server stopped answering, and no new one started in time')
}

// SIGTERM, then SIGKILL if it is still the current server after a grace.
async function killServer($: EngineInterface, server: ServerState, failed: Listening) {
  const isStillCurrent = async () => {
    const connection = await Promise.race([server.current.promise, $.clock.sleep(0)])

    return connection?.kind === 'listening' && connection.pid === failed.pid
  }

  if (!(await isStillCurrent())) {
    return
  }

  $.ui.log(`codemode: the server (pid ${failed.pid}) stopped answering; restarting it`)
  await $.process.run(['kill', String(failed.pid)]).catch(() => undefined)
  await $.clock.sleep(KILL_GRACE_MS)

  if (await isStillCurrent()) {
    await $.process.run(['kill', '-KILL', String(failed.pid)]).catch(() => undefined)
  }
}

export async function stopServerRun($: EngineInterface, server: ServerState, runId: string) {
  try {
    const connection = await listeningServer(server)
    await $.http.fetch('http://codemode/stop', {
      method: 'POST',
      socketPath: connection.socketPath,
      body: JSON.stringify({ runId }),
    })
  } catch (cause) {
    $.ui.log(`codemode: stopping run ${runId} failed: ${errorText(cause)}`, { to: 'debug' })
  }
}
