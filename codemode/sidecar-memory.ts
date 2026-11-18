// The VM's sidecar process and the memory it holds. Each evaluate leaves state
// on its context in the sidecar until the context is disposed, about 0.3 MB a
// run, and the sidecar keeps what it once allocated: a VM disposed and made
// again in the same sidecar gave nothing back (measured). Only a new sidecar
// does, so the server makes one when it holds too much.

import { readdir } from 'node:fs/promises'

export type SidecarProcess = { pid: number; residentBytes: number }

const SIDECAR_NAME = /^agentos/u
const RESIDENT_KB = /^VmRSS:\s+(\d+)\s+kB$/mu

// The sidecar among the children of `parentPid` (this server by default);
// undefined off Linux, or with no sidecar running.
export async function sidecarProcess(parentPid = process.pid) {
  try {
    for (const child of await childProcessIds(parentPid)) {
      const name = await Bun.file(`/proc/${child}/comm`).text()
      const kilobytes = RESIDENT_KB.exec(await Bun.file(`/proc/${child}/status`).text())?.[1]

      if (SIDECAR_NAME.test(name) && kilobytes !== undefined) {
        return {
          pid: Number(child),
          residentBytes: Number(kilobytes) * 1024,
        } satisfies SidecarProcess
      }
    }
  } catch {
    return undefined
  }

  return undefined
}

async function childProcessIds(parentPid: number) {
  const threads = await readdir(`/proc/${parentPid}/task`)
  const children = await Promise.all(
    threads.map((thread) => Bun.file(`/proc/${parentPid}/task/${thread}/children`).text()),
  )

  return children
    .join(' ')
    .split(/\s+/u)
    .filter((id) => id !== '')
}
