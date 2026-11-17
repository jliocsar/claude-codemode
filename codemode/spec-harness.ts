// The spec's stand-in for the plugin: spawns the real server, answers its tool
// calls with canned results (spec-answers.ts), and posts runs to it. Not a
// spec itself, so `bun test` runs it only through the specs.

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  cannedAnswer,
  fixtureDirectory,
  SLOW_QUERY,
  STUCK_QUERY,
  type ToolCallInput,
  toolCallInputSchema,
} from './spec-answers.ts'

export const TEST_TIMEOUT_MS = 60_000
export const TRICKY_STRING = 'a`b${c}\\d "e" \'f\'\nnext line'

export const zoomedSummarySchema = z.object({
  region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  size: z.object({ displayWidth: z.number(), displayHeight: z.number() }),
})

const READY_PREFIX = 'CODEMODE_READY '
const TOOL_CALL_PREFIX = 'CODEMODE_TOOL_CALL '
const SLOW_ANSWER_MS = 500

const CATALOG = [
  { name: 'Read', description: 'Reads a file from the local filesystem.' },
  { name: 'Edit', description: 'Performs exact string replacements in files.' },
  { name: 'Bash', description: 'Executes a bash command.' },
  { name: 'mcp__notes__search', description: 'Search notes by keyword.' },
]

const readyLineSchema = z.object({ socketPath: z.string(), pid: z.number() })
const toolCallLineSchema = z.object({ callId: z.string(), input: toolCallInputSchema })
const runReplySchema = z.object({
  text: z.string(),
  images: z.array(z.object({ mediaType: z.string(), base64: z.string() })),
})
const serverReplySchema = z.union([
  runReplySchema.extend({ pendingRunId: z.undefined().optional() }),
  z.object({ pendingRunId: z.string() }),
])

// A server that is gone, as one killed with SIGKILL leaves it: its scratch
// directory stays, for the next server to sweep.
const goneServer = Bun.spawn(['true'])
await goneServer.exited
export const goneScratchDirectory = join(tmpdir(), 'claude-codemode', String(goneServer.pid))
await Bun.write(join(goneScratchDirectory, 'agentos-left-behind'), '')

export const server = Bun.spawn(['bun', 'server.ts'], {
  cwd: import.meta.dir,
  stdout: 'pipe',
  stderr: 'ignore',
  // Short, so a run with a slow tool call goes through `/wait`, and that call
  // takes several host wait rounds.
  env: {
    ...Bun.env,
    CODEMODE_REPLY_WAIT_MS: '100',
    CODEMODE_HOST_WAIT_MS: '100',
    CLAUDE_CONFIG_DIR: fixtureDirectory,
  },
})
export const seenToolCalls: ToolCallInput[] = []
const serverSocketPath = waitForServerSocketPath()

export async function post(path: string, bodyJson: string) {
  const response = await fetch(`http://codemode${path}`, {
    unix: await serverSocketPath,
    method: 'POST',
    body: bodyJson,
  })

  return response.json()
}

// What the model reads: the text, and the images after it.
export async function run(
  {
    picturesToFiles,
    ...body
  }: {
    code: string
    inputs?: Record<string, string>
    cwd?: string
    maxRunMs?: number
    picturesToFiles?: boolean
  },
  runId = crypto.randomUUID(),
) {
  let reply = serverReplySchema.parse(
    await post('/run', JSON.stringify({ ...body, runId, catalog: CATALOG })),
  )

  while (reply.pendingRunId !== undefined) {
    reply = serverReplySchema.parse(
      await post('/wait', JSON.stringify({ runId: reply.pendingRunId, picturesToFiles })),
    )
  }

  return reply
}

// Stands in for the plugin: answers each tool call with a canned result, a
// slow query after a while and a stuck one never.
function answerToolCall(line: string) {
  const { callId, input } = toolCallLineSchema.parse(JSON.parse(line))
  seenToolCalls.push(input)
  const answerJson = JSON.stringify(cannedAnswer(callId, input))

  if (input['query'] === STUCK_QUERY) {
    return
  }

  setTimeout(
    () => void post('/answer', answerJson),
    input['query'] === SLOW_QUERY ? SLOW_ANSWER_MS : 0,
  )
}

// Reads the server's stdout for the test's life: the ready line settles the
// socket path, each tool call line is answered.
function waitForServerSocketPath() {
  const { promise, resolve, reject } = Promise.withResolvers<string>()

  void (async () => {
    let unfinishedLine = ''

    for await (const chunk of server.stdout.pipeThrough(new TextDecoderStream())) {
      const lines = `${unfinishedLine}${chunk}`.split('\n')
      unfinishedLine = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith(READY_PREFIX)) {
          resolve(readyLineSchema.parse(JSON.parse(line.slice(READY_PREFIX.length))).socketPath)
        } else if (line.startsWith(TOOL_CALL_PREFIX)) {
          answerToolCall(line.slice(TOOL_CALL_PREFIX.length))
        }
      }
    }

    reject(new Error(`codemode server exited with ${String(await server.exited)}`))
  })()

  return promise
}
