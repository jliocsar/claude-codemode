import type { EngineInterface, Register } from 'claude-code'

// Code mode: one `run` tool replaces every tool that only moves data. The model
// writes a TypeScript program, the codemode server (codemode/server.ts, a Node
// child) evaluates it in a Secure Exec VM, and each `tools.call` in it comes
// back here to run as a real Claude Code tool call, under the session's
// permissions.
//
// The relayed tools stay registered (the bridge needs them), but they are
// deferred and their names are cut from the deferred-tools reminder, so the
// model only sees `run` and the tools it calls directly.

type ToolCallInput = Parameters<EngineInterface['tool']['call']>[0]

// One stdout line from the codemode server, after its prefix.
type ToolCallLine = { callId: string; input: ToolCallInput }

type ServerConnection =
  | { kind: 'listening'; socketPath: string }
  | { kind: 'unavailable'; reason: string }

type SettleServerConnection = (connection: ServerConnection) => void

type SpawnedOutput = ReturnType<EngineInterface['process']['spawn']>

const READY_PREFIX = 'CODEMODE_READY '
const TOOL_CALL_PREFIX = 'CODEMODE_TOOL_CALL '
const RUN_TOOL_NAME = 'run'
const RUN_TOOL_FULL_NAME = 'mcp__codemode__run'
const NPM_ERROR_CHARACTERS = 500

// Tools that act on the conversation itself rather than return data: their
// output is meant for the model to read, or they change the session's state.
const CONVERSATION_TOOLS: ReadonlySet<string> = new Set([
  'Agent',
  'AskUserQuestion',
  'EndConversation',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Skill',
  'ToolSearch',
  'Workflow',
  RUN_TOOL_FULL_NAME,
])

const RUN_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: 'The body of an async TypeScript function. Use await, and return a JSON value.',
    },
    inputs: {
      type: 'object',
      description:
        'Data the code reads as `inputs`: file contents, edit strings, anything with quotes, backticks or backslashes.',
    },
  },
  required: ['code'],
  additionalProperties: false,
}

const RUN_TOOL_DESCRIPTION = `Run a TypeScript program against Claude Code's tools in an isolated VM. This is how you read, write and edit files, run shell commands, fetch and search the web, and call MCP servers: those tools are reachable only from here, unless you have them directly.

Loop, branch, batch and filter in one call, and return only what matters. \`code\` is the body of an async function: await the calls and \`return\` a JSON value. You read the value alone (a string as is), then any console.log output; a failed run reads \`run failed: <why>\`.

\`\`\`ts
declare const tools: {
  /**
   * Run one tool by name, e.g. "Read", "Edit", "Bash", "WebFetch", "mcp__<server>__<tool>".
   * \`result\`: the tool's own record (Read's file, Bash's streams), else \`text\` parsed when JSON, else \`text\`.
   */
  call(name: string, input: object): Promise<{ text: string; isError: boolean; result: unknown }>
  /** Find tools by words in their name or description; each comes with its input type. "" lists them all. */
  search(query: string): Promise<{ name: string; description: string; input: string }[]>
}
declare const inputs: any
\`\`\`

Search before calling a tool whose input you don't know. Common ones: Read { file_path, offset?, limit? }, Write { file_path, content }, Edit { file_path, old_string, new_string, replace_all? }, Bash { command, timeout? }.
Put file contents, edit strings and any text with quotes, backticks or backslashes in \`inputs\` and read them as \`inputs.name\`. Never write them inline in \`code\`.
The VM has no network and no real filesystem: \`tools\` is the only way out, and every call goes through the usual permissions.
The code is type-checked against each tool's real input type first. A type error comes back without anything running.`

export const register: Register = (on) => {
  // Settles once: with the socket path when the server is ready, or with why it never will be.
  let settleServerConnection: SettleServerConnection = () => undefined
  const serverConnection = new Promise<ServerConnection>((resolve) => {
    settleServerConnection = resolve
  })

  on('session.start', async ($, event, next) => {
    const started = await next(event)
    await $.tool.register({
      name: RUN_TOOL_NAME,
      description: RUN_TOOL_DESCRIPTION,
      inputSchema: RUN_INPUT_SCHEMA,
    })
    $.ui.invalidate('tool.describe')
    void runCodemodeServer($, settleServerConnection)

    return started
  })

  on('tool.call', { tool: RUN_TOOL_FULL_NAME }, async ($, event) => {
    const [connection, catalog] = await Promise.all([serverConnection, relayedToolCatalog($)])

    if (connection.kind === 'unavailable') {
      return { deny: `codemode server unavailable: ${connection.reason}` }
    }

    try {
      const response = await $.http.fetch('http://codemode/run', {
        method: 'POST',
        socketPath: connection.socketPath,
        body: JSON.stringify({ code: event.code, inputs: event.inputs ?? {}, catalog }),
      })

      return { result: response.text }
    } catch (cause) {
      return { deny: `codemode server unavailable: ${errorText(cause)}` }
    }
  })

  // `run` in the prompt's list; every relayed tool behind ToolSearch.
  on('tool.describe', async ($, event, next) => {
    const [described, customTools] = await Promise.all([next(event), customConversationTools($)])

    if (event.tool === RUN_TOOL_FULL_NAME) {
      return { ...described, isDeferred: false }
    }

    return isRelayedTool(event.tool, customTools) ? { ...described, isDeferred: true } : described
  })

  on('prompt.attachment', { type: 'deferred_tools_delta' }, async ($, event, next) => {
    const [attached, customTools] = await Promise.all([next(event), customConversationTools($)])

    return attached.text === null
      ? attached
      : { ...attached, text: withoutRelayedToolNames(attached.text, customTools) }
  })
}

// More tools the model calls directly, outside `run`: comma separated names in
// CLAUDE_CODEMODE_CUSTOM_CONVERSATION_TOOLS, a trailing `*` matching by prefix,
// e.g. `mcp__executor__*,mcp__fff__grep`.
async function customConversationTools($: EngineInterface): Promise<readonly string[]> {
  try {
    const listed = await $.env.get('CLAUDE_CODEMODE_CUSTOM_CONVERSATION_TOOLS')

    return (listed ?? '').split(',').flatMap((entry) => entry.trim() || [])
  } catch (cause) {
    $.ui.log(`codemode: reading custom conversation tools failed: ${errorText(cause)}`)

    return []
  }
}

function isRelayedTool(tool: string, customTools: readonly string[]) {
  return (
    !CONVERSATION_TOOLS.has(tool) &&
    !customTools.some((entry) =>
      entry.endsWith('*') ? tool.startsWith(entry.slice(0, -1)) : tool === entry,
    )
  )
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

async function relayedToolCatalog($: EngineInterface) {
  const [sessionTools, customTools] = await Promise.all([$.tool.list(), customConversationTools($)])

  return sessionTools
    .filter(({ name }) => isRelayedTool(name, customTools))
    .map(({ name, description }) => ({ name, description }))
}

// Installs the server's packages on first start, then runs it for the session's life.
async function runCodemodeServer($: EngineInterface, settle: SettleServerConnection) {
  const serverDirectory = `${$.plugin.root}/codemode`

  try {
    if (!(await $.fs.exists(`${serverDirectory}/node_modules/secure-exec`))) {
      $.ui.toast('codemode: installing the server (first start only)')
      const installed = await $.process.run(['npm', 'install', '--no-audit', '--no-fund'], {
        cwd: serverDirectory,
      })

      if (installed.exitCode !== 0) {
        throw new Error(`npm install failed: ${installed.stderr.slice(-NPM_ERROR_CHARACTERS)}`)
      }
    }

    let socketPath = ''
    const serverOutput = $.process.spawn({ argv: ['node', 'server.ts'], cwd: serverDirectory })

    for await (const line of stdoutLines(serverOutput)) {
      // The server prints its ready line before it accepts a run, so every
      // tool call line comes after it.
      if (line.startsWith(READY_PREFIX)) {
        socketPath = line.slice(READY_PREFIX.length)
        settle({ kind: 'listening', socketPath })
      } else if (line.startsWith(TOOL_CALL_PREFIX)) {
        void answerToolCall($, socketPath, line.slice(TOOL_CALL_PREFIX.length))
      }
    }

    settle({ kind: 'unavailable', reason: 'the codemode server exited' })
  } catch (cause) {
    settle({ kind: 'unavailable', reason: errorText(cause) })
    $.ui.log(`codemode: the server did not start: ${errorText(cause)}`)
  }
}

// Whole stdout lines of a child process, however its chunks split them.
async function* stdoutLines(output: SpawnedOutput) {
  let unfinishedLine = ''

  for await (const chunk of output) {
    if (chunk.stream === 'stdout') {
      const lines = `${unfinishedLine}${chunk.text}`.split('\n')
      unfinishedLine = lines.pop() ?? ''
      yield* lines
    }
  }
}

async function runRelayedTool($: EngineInterface, { callId, input }: ToolCallLine) {
  if (!isRelayedTool(input.tool, await customConversationTools($))) {
    return {
      callId,
      outcome: 'denied',
      reason: `${input.tool} is called directly, not from code`,
    }
  }

  try {
    const called = await $.tool.call(input)

    return called.deny === undefined
      ? {
          callId,
          outcome: 'answered',
          text: called.text ?? '',
          isError: called.isError === true,
          result: called.result ?? null,
        }
      : { callId, outcome: 'denied', reason: called.deny }
  } catch (cause) {
    return { callId, outcome: 'failed', reason: errorText(cause) }
  }
}

async function answerToolCall($: EngineInterface, socketPath: string, toolCallText: string) {
  try {
    // SAFETY: the codemode server writes these lines, after zod checked the input is an object; the tool validates its own fields.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON from our own child process
    const toolCallLine = JSON.parse(toolCallText) as ToolCallLine
    const answer = await runRelayedTool($, toolCallLine)
    await $.http.fetch('http://codemode/answer', {
      method: 'POST',
      socketPath,
      body: JSON.stringify(answer),
    })
  } catch (cause) {
    $.ui.log(`codemode: answering a tool call failed: ${errorText(cause)}`, { to: 'debug' })
  }
}

// The reminder lists one deferred tool name per line under a sentence or two
// of framing. Drops the relayed names, and the whole reminder when none is left.
function isToolNameLine(line: string) {
  const trimmed = line.trim()

  return trimmed !== '' && !trimmed.includes(' ')
}

function withoutRelayedToolNames(reminderText: string, customTools: readonly string[]) {
  const keptLines = reminderText
    .split('\n')
    .filter(
      (line) =>
        !isToolNameLine(line) ||
        (!isRelayedTool(line.trim(), customTools) && line.trim() !== RUN_TOOL_FULL_NAME),
    )

  return keptLines.some(isToolNameLine) ? keptLines.join('\n') : null
}
