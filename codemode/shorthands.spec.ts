// The shorthands (`$`, `read`, `write`, `edit`, `keep`), the last expression
// as the value, and the run list, cap, background pictures and scratch
// directory around them.

import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
  SHOT_BASE64,
  SHOT_PATH,
  SLOW_QUERY,
  STUCK_QUERY,
  UNREAD_PATH,
  WORK_DIRECTORY,
} from './spec-answers.ts'
import {
  goneScratchDirectory,
  run,
  seenToolCalls,
  server,
  TEST_TIMEOUT_MS,
} from './spec-harness.ts'

test(
  '$ quotes what it interpolates as Bun Shell does, and reads the output',
  async () => {
    const reply = await run({
      code: 'const text = await $`echo ${inputs.quoted} ${["a b", "c"]} ${{ raw: "|" }}`.text()\nconst lines = await $`echo one\ntwo`.lines()\nconst json = await $`echo {"n":1}`.json()\nreturn { text, lines, json }',
      inputs: { quoted: "it's" },
    })

    expect(seenToolCalls.at(-3)).toEqual({ tool: 'Bash', command: "echo 'it'\\''s' 'a b' c |" })

    expect(JSON.parse(reply.text)).toEqual({
      text: "'it'\\''s' 'a b' c |",
      lines: ['one', 'two'],
      json: { n: 1 },
    })
  },
  TEST_TIMEOUT_MS,
)

test(
  '$ throws on a failed command unless nothrow, and cwd runs it in a directory',
  async () => {
    const reply = await run({
      code: 'const failed = await $`fail`.nothrow()\nlet thrown = ""\ntry { await $`fail` } catch (error) { thrown = `${error.exitCode}: ${error.message}` }\nconst inside = await $`echo here`.cwd("sub").text()\nreturn { failed, thrown, inside }',
      cwd: WORK_DIRECTORY,
    })

    expect(JSON.parse(reply.text)).toEqual({
      failed: { stdout: 'boom', stderr: '', exitCode: 2 },
      thrown: '2: exit code 2: boom',
      inside: 'here',
    })

    expect(seenToolCalls.at(-1)).toEqual({ tool: 'Bash', command: 'cd /work/sub && echo here' })
  },
  TEST_TIMEOUT_MS,
)

test(
  'edit takes a path from the session directory, and reads the file first when the tool asks',
  async () => {
    const toolCallsBefore = seenToolCalls.length
    const reply = await run({
      code: 'await edit("unread.ts", "un", "")\nreturn await read("./unread.ts")',
      cwd: WORK_DIRECTORY,
    })

    expect(reply.text).toBe('unread')

    expect(seenToolCalls.slice(toolCallsBefore).map(({ tool }) => tool)).toEqual([
      'Edit',
      'Read',
      'Edit',
      'Read',
    ])

    expect(seenToolCalls.at(-2)).toEqual({
      tool: 'Edit',
      file_path: UNREAD_PATH,
      old_string: 'un',
      new_string: '',
      replace_all: false,
    })
  },
  TEST_TIMEOUT_MS,
)

test(
  'the last expression is the value; with none, the console output alone',
  async () => {
    const replies = await Promise.all([
      run({ code: 'const half = 21\n// the answer\nhalf * 2;' }),
      run({ code: 'console.log("only printed")' }),
      run({ code: 'const nothing = 1' }),
    ])

    expect(replies.map(({ text }) => text)).toEqual(['42', 'only printed', '(no value)'])
  },
  TEST_TIMEOUT_MS,
)

test(
  'keep carries a value from one run to the next',
  async () => {
    await run({ code: 'await keep.set("found", { files: ["a.ts"] })' })
    const reply = await run({
      code: 'return [await keep.get("found"), await keep.delete("found"), await keep.get("found")]',
    })

    expect(JSON.parse(reply.text)).toEqual([{ files: ['a.ts'] }, true, null])
  },
  TEST_TIMEOUT_MS,
)

test(
  'tools.runs lists a run still going, and a capped run stops past its cap',
  async () => {
    const runId = crypto.randomUUID()
    const capped = run(
      {
        code: `await tools.call("mcp__notes__search", { query: "${STUCK_QUERY}" })\nreturn "finished"`,
        maxRunMs: 1500,
      },
      runId,
    )

    while (!seenToolCalls.some((input) => input['query'] === STUCK_QUERY)) {
      await Bun.sleep(50)
    }

    const listed = await run({
      code: 'return (await tools.runs()).map(({ id, code }) => ({ id, code }))',
    })

    expect(JSON.parse(listed.text)).toContainEqual({
      id: runId,
      code: 'await tools.call("mcp__notes__search", { query: "stuck" })',
    })

    expect((await capped).text).toMatch(/^run failed: [^]*CLAUDE_CODEMODE_MAX_RUN_MS/u)
  },
  TEST_TIMEOUT_MS,
)

test(
  "a background run's pictures are saved as files its text names",
  async () => {
    const reply = await run({
      // Slow enough that the reply comes from `/wait`, as a background run's does.
      code: `await tools.call("mcp__notes__search", { query: "${SLOW_QUERY}" })\nreturn (await tools.call("Read", { file_path: "${SHOT_PATH}" })).result`,
      picturesToFiles: true,
    })
    const savedPath = reply.text.trim().split('\n').at(-1) ?? ''

    expect(reply.images).toEqual([])

    expect(savedPath).toMatch(/claude-codemode\/\d+\/pictures\/.+-1\.png$/u)

    expect(await Bun.file(savedPath).text()).toBe(atob(SHOT_BASE64))
  },
  TEST_TIMEOUT_MS,
)

test(
  "the VM's temporary files stay in the server's own directory, and gone servers' are swept",
  () => {
    const ownDirectory = join(tmpdir(), 'claude-codemode', String(server.pid))

    expect(readdirSync(ownDirectory).some((entry) => entry.startsWith('agentos-'))).toBe(true)

    expect(readdirSync(join(tmpdir(), 'claude-codemode'))).not.toContain(
      String(goneScratchDirectory.split('/').at(-1)),
    )
  },
  TEST_TIMEOUT_MS,
)
