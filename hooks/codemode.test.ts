import { expect, mock, test } from 'claude-code/testing'

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
