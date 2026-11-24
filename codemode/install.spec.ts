import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INSTALL_LOCK, INSTALL_TEMP, INSTALLED_MARKER, installOnce } from './install.ts'

const directories: string[] = []

function pluginDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'codemode-install-'))
  directories.push(directory)

  return directory
}

// Stands in for `bun install`: notes each run and where Bun would unpack, and
// leaves a half-unpacked package there, as a cut install did.
function fakeInstall(directory: string, exitCode = 0) {
  return [
    'sh',
    '-c',
    `echo "$BUN_TMPDIR" >> ${join(directory, 'runs.log')}; mkdir -p "$BUN_TMPDIR/.0-1.agentos-sidecar"; sleep 0.3; exit ${exitCode}`,
  ]
}

function runs(directory: string) {
  return readFileSync(join(directory, 'runs.log'), 'utf8').trim().split('\n')
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('sessions starting together run one install, which unpacks into its own directory and removes it', async () => {
  const directory = pluginDirectory()
  const installs = await Promise.all(
    [1, 2, 3].map(() => installOnce(directory, fakeInstall(directory))),
  )

  expect(installs.filter(({ ran }) => ran)).toHaveLength(1)
  expect(installs.every(({ exitCode }) => exitCode === 0)).toBe(true)
  expect(runs(directory)).toEqual([join(directory, INSTALL_TEMP)])
  expect(existsSync(join(directory, INSTALLED_MARKER))).toBe(true)
  expect(existsSync(join(directory, INSTALL_TEMP))).toBe(false)
  expect(existsSync(join(directory, INSTALL_LOCK))).toBe(false)
})

test('a failed install leaves no marker and nothing unpacked, and the next start tries again', async () => {
  const directory = pluginDirectory()
  const failed = await installOnce(directory, fakeInstall(directory, 1))

  expect(failed).toMatchObject({ ran: true, exitCode: 1 })
  expect(existsSync(join(directory, INSTALLED_MARKER))).toBe(false)
  expect(existsSync(join(directory, INSTALL_TEMP))).toBe(false)
  expect((await installOnce(directory, fakeInstall(directory))).ran).toBe(true)
})

test('a lock and a half-unpacked directory left by a killed install are taken over', async () => {
  const directory = pluginDirectory()
  const gone = Bun.spawn(['true'])
  await gone.exited
  mkdirSync(join(directory, INSTALL_LOCK))
  writeFileSync(join(directory, INSTALL_LOCK, 'pid'), String(gone.pid))
  mkdirSync(join(directory, INSTALL_TEMP, '.0-1.agentos-sidecar'), { recursive: true })

  expect((await installOnce(directory, fakeInstall(directory))).ran).toBe(true)
  expect(existsSync(join(directory, INSTALL_TEMP))).toBe(false)
})

test('an install already done runs nothing', async () => {
  const directory = pluginDirectory()
  mkdirSync(join(directory, 'node_modules'))
  writeFileSync(join(directory, INSTALLED_MARKER), 'done')

  expect((await installOnce(directory, fakeInstall(directory))).ran).toBe(false)
  expect(existsSync(join(directory, 'runs.log'))).toBe(false)
})
