// The server's packages, installed once per plugin directory however many
// sessions start at once. The plugin runs it as `bun install.ts` before the
// server, so it imports nothing the install brings.
//
// Sessions restarted together onto a new version each ran their own
// `bun install`, each cut at 30 s, before a cold cache's 1.2 GB of sidecar
// binaries were in; Bun left every package it was unpacking half-written under
// /tmp for good, 4.5 GB of them in a morning (seen). So one install runs at a
// time, the others wait for it, and Bun unpacks into a directory of our own
// that goes once the install ends.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Installed = { ran: boolean; exitCode: number; stderr: string }

const LOCK_OWNER = 'pid'
const POLL_MS = 250
// A lock with no owner written yet is still being taken, unless it is this old.
const OWNERLESS_LOCK_MS = 10_000
const INSTALL_COMMAND = ['bun', 'install', '--frozen-lockfile']
const STDERR_CHARACTERS = 2_000

export const INSTALLED_MARKER = join('node_modules', '.codemode-installed')
// A directory: making one is atomic, so one process holds it.
export const INSTALL_LOCK = '.install-lock'
// Where Bun unpacks packages before moving them into its cache (BUN_TMPDIR).
export const INSTALL_TEMP = '.install-tmp'

// Bun names the code in the message (`EEXIST: file already exists, mkdir …`,
// `kill() failed: EPERM: …`), and zod, which reads `code` elsewhere, is not
// installed yet when this runs.
function hasCode(cause: unknown, code: string) {
  return cause instanceof Error && cause.message.includes(`${code}:`)
}

function isRunning(processId: number) {
  try {
    process.kill(processId, 0)

    return true
  } catch (cause) {
    // EPERM: it runs, as another user.
    return hasCode(cause, 'EPERM')
  }
}

// Whether a lock is held by a process gone, or by none for too long.
function isStale(lockDirectory: string) {
  try {
    const owner = Number(readFileSync(join(lockDirectory, LOCK_OWNER), 'utf8'))

    if (Number.isInteger(owner) && owner > 0) {
      return !isRunning(owner)
    }
  } catch {}

  try {
    return Date.now() - statSync(lockDirectory).mtimeMs > OWNERLESS_LOCK_MS
  } catch {
    // Gone meanwhile: the next try takes it.
    return false
  }
}

// True once this process holds the lock.
function takeLock(lockDirectory: string) {
  try {
    mkdirSync(lockDirectory)
  } catch (cause) {
    if (!hasCode(cause, 'EEXIST')) {
      throw cause
    }

    if (isStale(lockDirectory)) {
      rmSync(lockDirectory, { recursive: true, force: true })
    }

    return false
  }

  writeFileSync(join(lockDirectory, LOCK_OWNER), String(process.pid))

  return true
}

// Installs `directory`'s packages unless they are already, or another process
// installs them meanwhile; `command` stands in for `bun install` in specs.
export async function installOnce(
  directory: string,
  command: readonly string[] = INSTALL_COMMAND,
): Promise<Installed> {
  const marker = join(directory, INSTALLED_MARKER)
  const lockDirectory = join(directory, INSTALL_LOCK)

  for (;;) {
    if (existsSync(marker)) {
      return { ran: false, exitCode: 0, stderr: '' }
    }

    if (takeLock(lockDirectory)) {
      break
    }

    await Bun.sleep(POLL_MS)
  }

  const temp = join(directory, INSTALL_TEMP)

  try {
    // Another install may have finished between the check and the lock.
    if (existsSync(marker)) {
      return { ran: false, exitCode: 0, stderr: '' }
    }

    // What a killed install left.
    rmSync(temp, { recursive: true, force: true })
    mkdirSync(temp, { recursive: true })
    const install = Bun.spawn([...command], {
      cwd: directory,
      env: { ...Bun.env, BUN_TMPDIR: temp },
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const [exitCode, stderr] = await Promise.all([
      install.exited,
      new Response(install.stderr).text(),
    ])

    if (exitCode === 0) {
      mkdirSync(join(directory, 'node_modules'), { recursive: true })
      writeFileSync(marker, new Date().toISOString())
    }

    return { ran: true, exitCode, stderr: stderr.slice(-STDERR_CHARACTERS) }
  } finally {
    rmSync(temp, { recursive: true, force: true })
    rmSync(lockDirectory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const installed = await installOnce(import.meta.dir)

  if (installed.exitCode !== 0) {
    process.stderr.write(installed.stderr)
    process.exit(installed.exitCode)
  }
}
