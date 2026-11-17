// Preloaded by `bun test` (bunfig.toml), so its afterAll runs once, after
// every spec file: process exit hooks never fire under `bun test`, and an
// afterAll in one spec file would stop the server the next file still needs.

import { rmSync } from 'node:fs'
import { afterAll } from 'bun:test'
import { fixtureDirectory } from './spec-answers.ts'
import { server } from './spec-harness.ts'

afterAll(() => {
  server.kill('SIGTERM')
  rmSync(fixtureDirectory, { recursive: true, force: true })
})
