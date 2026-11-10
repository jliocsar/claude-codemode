// The tool calls a program makes, run here as real Claude Code tool calls,
// under the session's permissions, and answered over the server's socket.

import type { EngineInterface } from 'claude-code'
import { isRelayedTool } from './run-tool'
import { errorText } from './server-connection'

type ToolCallInput = Parameters<EngineInterface['tool']['call']>[0]

// One stdout line from the codemode server, after its prefix. `discardResult`:
// the call is a permission check, and its answer carries no output.
type ToolCallLine = { callId: string; input: ToolCallInput; discardResult?: boolean }

const ANSWER_ATTEMPTS = 3
const ANSWER_RETRY_MS = 500

// More tools the model calls directly, outside `run`: comma separated names in
// CLAUDE_CODEMODE_CUSTOM_CONVERSATION_TOOLS, a trailing `*` matching by prefix,
// e.g. `mcp__executor__*,mcp__fff__grep`. Read once a session.
export function customConversationTools($: EngineInterface) {
  customToolsRead ??= readCustomConversationTools($)

  return customToolsRead
}

async function readCustomConversationTools($: EngineInterface): Promise<readonly string[]> {
  try {
    const listed = await $.env.get('CLAUDE_CODEMODE_CUSTOM_CONVERSATION_TOOLS')

    return (listed ?? '').split(',').flatMap((entry) => entry.trim() || [])
  } catch (cause) {
    $.ui.log(`codemode: reading custom conversation tools failed: ${errorText(cause)}`)

    return []
  }
}

async function runRelayedTool(
  $: EngineInterface,
  { callId, input, discardResult = false }: ToolCallLine,
  customTools: readonly string[],
) {
  if (!isRelayedTool(input.tool, customTools)) {
    return {
      callId,
      outcome: 'denied',
      reason: `${input.tool} is called directly, not from code`,
    }
  }

  try {
    const called = await $.tool.call(input)

    if (called.deny !== undefined) {
      return { callId, outcome: 'denied', reason: called.deny }
    }

    const isError = called.isError === true
    const keepsOutput = isError || !discardResult

    return {
      callId,
      outcome: 'answered',
      text: keepsOutput ? (called.text ?? '') : '',
      isError,
      result: keepsOutput ? (called.result ?? null) : null,
    }
  } catch (cause) {
    return { callId, outcome: 'failed', reason: errorText(cause) }
  }
}

// Runs the tool and posts its answer, again on a failed post: a lost answer
// leaves the program waiting on its call until the run is stopped.
export async function answerToolCall($: EngineInterface, socketPath: string, toolCallText: string) {
  let answerJson: string

  try {
    // SAFETY: the codemode server writes these lines, after zod checked the input is an object; the tool validates its own fields.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON from our own child process
    const toolCallLine = JSON.parse(toolCallText) as ToolCallLine
    const answer = await runRelayedTool($, toolCallLine, await customConversationTools($))
    answerJson = JSON.stringify(answer)
  } catch (cause) {
    $.ui.log(`codemode: a tool call line could not be read: ${errorText(cause)}`)

    return
  }

  for (let attempt = 1; attempt <= ANSWER_ATTEMPTS; attempt++) {
    try {
      await $.http.fetch('http://codemode/answer', { method: 'POST', socketPath, body: answerJson })

      return
    } catch (cause) {
      $.ui.log(`codemode: answering a tool call failed (try ${attempt}): ${errorText(cause)}`, {
        to: 'debug',
      })
      await $.clock.sleep(ANSWER_RETRY_MS * attempt)
    }
  }
}

// What readCustomConversationTools found, read once a session.
let customToolsRead: Promise<readonly string[]> | undefined
