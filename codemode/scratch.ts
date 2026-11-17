// The server's own scratch directory, made before Secure Exec loads, with
// TMPDIR pointed into it: the VM's sidecar keeps its sockets, shadow roots and
// import caches there (measured), instead of loose in /tmp, where a killed
// server left them for good. The directories of servers that are gone are
// swept on start, since a killed server cannot clean up after itself.

import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const scratchBase = join(tmpdir(), 'claude-codemode')
// EPERM: the process runs, as another user.
const runsAsAnotherUserSchema = z.object({ code: z.literal('EPERM') })

export const scratchDirectory = join(scratchBase, String(process.pid))

function isRunning(processId: number) {
  try {
    process.kill(processId, 0)

    return true
  } catch (cause) {
    return runsAsAnotherUserSchema.safeParse(cause).success
  }
}

function sweepGoneServers() {
  let entries: string[]

  try {
    entries = readdirSync(scratchBase)
  } catch {
    return
  }

  for (const entry of entries) {
    const processId = Number(entry)

    if (Number.isInteger(processId) && processId > 0 && !isRunning(processId)) {
      rmSync(join(scratchBase, entry), { recursive: true, force: true })
    }
  }
}

export function removeScratch() {
  rmSync(scratchDirectory, { recursive: true, force: true })
}

sweepGoneServers()
mkdirSync(scratchDirectory, { recursive: true })
process.env['TMPDIR'] = scratchDirectory
