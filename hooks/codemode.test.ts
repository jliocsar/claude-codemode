import { expect, mock, test } from 'claude-code/testing'
import { callLogLine, callLogMode, runSummaryLine } from './call-log'
import { subagentCall } from './run-owners'
import { finishedBackgroundRunText, runResult } from './run-tool'

const ENGINE_PROVIDER = { plugin: 'engine', tier: 'core' } as const
const ENGINE_ORIGIN = { kind: 'engine' } as const

const DEFERRED_TOOLS_REMINDER = [
  'The following deferred tools are now available via ToolSearch:',
  'Bash',
  'ExitPlanMode',
  'mcp__executor__execute',
  'mcp__notes__search',
].join('\n')

test('relayed tools sit behind ToolSearch, conversation tools stay as they were', async ($, on) => {
  on('tool.describe', (_engine, event) => ({ description: event.description }))
  const bash = await $.tool.describe({
    tool: 'Bash',
    description: 'Runs a command.',
    provider: ENGINE_PROVIDER,
  })
  const notes = await $.tool.describe({
    tool: 'mcp__notes__search',
    description: 'Search notes.',
    provider: { plugin: 'mcp:notes', tier: 'user' },
  })
  const agent = await $.tool.describe({
    tool: 'Agent',
    description: 'Runs a subagent.',
    provider: ENGINE_PROVIDER,
  })

  expect(bash.isDeferred).toBe(true)
  expect(notes.isDeferred).toBe(true)
  expect(agent.isDeferred).not.toBe(true)
})

test('custom conversation tools stay with the model, outside run', async ($, on) => {
  mock.env(on, {
    CLAUDE_CODEMODE_CUSTOM_CONVERSATION_TOOLS: 'mcp__notes__search, mcp__executor__*',
  })
  on('tool.describe', (_engine, event) => ({ description: event.description }))
  const execute = await $.tool.describe({
    tool: 'mcp__executor__execute',
    description: 'Execute TypeScript in a sandboxed runtime.',
    provider: { plugin: 'mcp:executor', tier: 'user' },
  })

  const notes = await $.tool.describe({
    tool: 'mcp__notes__search',
    description: 'Search notes.',
    provider: { plugin: 'mcp:notes', tier: 'user' },
  })

  expect(execute.isDeferred).not.toBe(true)
  expect(notes.isDeferred).not.toBe(true)
})

test('run stays in the prompt list', async ($, on) => {
  on('tool.describe', (_engine, event) => ({ description: event.description, isDeferred: true }))
  const run = await $.tool.describe({
    tool: 'mcp__codemode__run',
    description: 'Run a program.',
    isDeferred: true,
    provider: { plugin: 'codemode', tier: 'user' },
  })

  expect(run.isDeferred).toBe(false)
})

test('the deferred tools reminder keeps only tools code mode does not relay', async ($, on) => {
  mock.env(on, { CLAUDE_CODEMODE_CUSTOM_CONVERSATION_TOOLS: 'mcp__executor__*' })
  on('prompt.attachment', (_engine, event) => ({ text: event.text }))
  const attached = await $.prompt.attachment({
    type: 'deferred_tools_delta',
    text: DEFERRED_TOOLS_REMINDER,
    origin: ENGINE_ORIGIN,
  })

  expect(attached.text).toBe(
    'The following deferred tools are now available via ToolSearch:\nExitPlanMode\nmcp__executor__execute',
  )
})

test('a reminder listing only relayed tools is dropped', async ($, on) => {
  on('prompt.attachment', (_engine, event) => ({ text: event.text }))
  const attached = await $.prompt.attachment({
    type: 'deferred_tools_delta',
    origin: ENGINE_ORIGIN,
    text: 'The following deferred tools are now available via ToolSearch:\nBash\nRead',
  })

  expect(attached.text).toBe(null)
})

test('a run reply with pictures becomes text and image blocks', () => {
  const plain = runResult({ text: 'done', images: [] })
  const pictured = runResult({
    text: '[image 1]',
    images: [{ mediaType: 'image/png', base64: 'c2hvdA==' }],
  })

  expect(plain).toBe('done')
  expect(pictured).toEqual([
    { type: 'text', text: '[image 1]' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c2hvdA==' } },
  ])
})

test('a background run comes back as a message, counting the pictures it cannot carry', () => {
  const message = finishedBackgroundRunText('run-1', {
    text: 'built',
    images: [{ mediaType: 'image/png', base64: 'c2hvdA==' }],
  })

  expect(message).toMatch(
    /^codemode: background run run-1 finished\.\n\nbuilt\n\n\(1 returned picture/u,
  )
})
test('a run sums up its calls in one row: counts, edited files, what went wrong', () => {
  const cwd = '/repo'
  const ok = { denied: false, isError: false, text: '' } as const
  const line = runSummaryLine(
    [
      { input: { tool: 'Bash', command: "cd '/repo/pkgs' && grep -rn x ." }, outcome: ok },
      { input: { tool: 'Read', file_path: '/repo/a.ts' }, outcome: ok },
      {
        input: {
          tool: 'Edit',
          file_path: '/repo/a.ts',
          old_string: 'one',
          new_string: 'two\nthree',
        },
        outcome: ok,
      },
      {
        input: { tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' },
        outcome: ok,
      },
      {
        input: { tool: 'Bash', command: 'cd /repo && npm test' },
        outcome: { denied: false, isError: true, text: 'Exit code 2\nboom' },
      },
      { input: { tool: 'Read', file_path: '/etc/hosts' }, outcome: { denied: true } },
    ],
    cwd,
  )

  expect(line).toBe(
    '↳ $ ×2 · Read ×2 · Edit ×2 · edited a.ts +3 −2 · $ npm test — exit 2, Read /etc/hosts — denied',
  )
  expect(runSummaryLine([], cwd)).toBe(null)
})

test('a row per call drops the leading cd and the plugin name the engine adds itself', () => {
  const line = callLogLine(
    { tool: 'Bash', command: 'cd /repo/pkgs && npm pack x\nls' },
    { denied: false, isError: false, text: '' },
    '/repo',
  )

  expect(line).toBe('↳ $ npm pack x…')
})

test('the call log is a row per run unless set to calls, debug or off', () => {
  expect([undefined, 'calls', 'debug', 'off', 'x'].map(callLogMode)).toEqual([
    'run',
    'calls',
    'debug',
    'off',
    'run',
  ])
})
test("a subagent's run keeps Bash in the foreground, so no notice reaches the parent session", () => {
  expect(subagentCall({ tool: 'Bash', command: 'make', run_in_background: true })).toEqual({
    refusal: expect.stringContaining('parent session'),
  })
  expect(subagentCall({ tool: 'Bash', command: 'make' })).toEqual({
    input: { tool: 'Bash', command: 'make', timeout: 600_000 },
  })
  expect(subagentCall({ tool: 'Bash', command: 'make', timeout: 5000 })).toEqual({
    input: { tool: 'Bash', command: 'make', timeout: 5000 },
  })
  expect(subagentCall({ tool: 'Read', file_path: '/a' })).toEqual({
    input: { tool: 'Read', file_path: '/a' },
  })
})
