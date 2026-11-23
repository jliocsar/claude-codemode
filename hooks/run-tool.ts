// The `run` tool as the model sees it: its name, input schema and
// description, the tools it stands in for, and how the server's reply becomes
// its result.

// The server's reply to a run: the text the model reads, then its pictures.
type RunReply = { text: string; images: { mediaType: string; base64: string }[] }

// A finished run's reply, or the id of one still going, to ask `/wait` about.
export type ServerReply = (RunReply & { pendingRunId?: undefined }) | { pendingRunId: string }

// A background run's reply travels as a prompt: past this, it is cut.
const BACKGROUND_REPLY_CHARACTERS = 100_000

export const RUN_TOOL_NAME = 'run'
export const RUN_TOOL_FULL_NAME = 'mcp__codemode__run'

// Tools that act on the conversation itself rather than return data: their
// output is meant for the model to read, or they change the session's state.
export const CONVERSATION_TOOLS: ReadonlySet<string> = new Set([
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
  'Monitor',
  RUN_TOOL_FULL_NAME,
])

export const RUN_INPUT_SCHEMA = {
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

export const RUN_TOOL_DESCRIPTION = `Run TypeScript in an isolated VM: how you use Claude Code's tools (files, shell, web, MCP). Loop, batch and filter in one run; return only what you need.

\`code\` is an async function body. Its last expression (or \`return\`) is the result, a string as is, else JSON, then any console output. It's type-checked first: a type error runs nothing.

\`\`\`ts
/** Bun Shell's \`$\` over Bash: \`\${x}\` is quoted; await gives {stdout, stderr, exitCode} (stderr merged into stdout), throwing on a non-zero exit unless .nothrow(). Also .text() .json() .lines() .cwd(dir) */
declare const $: Shell
/** Relative paths start at the session's directory. */
declare function read(path: string, options?: { offset?: number; limit?: number }): Promise<string>
declare function write(path: string, content: string): Promise<void>
declare function edit(path: string, oldText: string, newText: string, options?: { all?: boolean }): Promise<void>
/** Async get/set/delete of JSON values kept across runs. */
declare const keep: AsyncMap<string, any>
declare const tools: {
  /** Any tool, e.g. "WebFetch", "mcp__<server>__<tool>". result: its own record (Read's file), else its text, parsed when JSON. */
  call(name: string, input: object): Promise<{ text: string; isError: boolean; result: unknown }>
  /** Tools matching the words, with input types; "" lists all. */
  search(query: string): Promise<{ name: string; description: string; input: string }[]>
  /** An image region at its own pixels, enlarged; region in the file's pixels. */
  zoom(path: string, region: { x: number; y: number; width: number; height: number }): Promise<object>
  runs(): Promise<{ id: string; seconds: number; code: string }[]>
  stopRun(id: string): Promise<boolean>
}
declare const inputs: any
\`\`\`

Pictures reach you only when returned: Read's \`result\` for an image or PDF, or zoom's.
Search for a tool before calling one whose input you don't know.
A run past 2 min moves to the background (in a subagent, it's waited out); its result arrives later as a message, so don't poll.
A tool call with no answer in 15 min throws, and a run is stopped at 2 h.
Text with quotes, backticks or backslashes goes in \`inputs\`, never inline in \`code\`.
No network or real filesystem: these globals are the only way out, under the usual permissions.`

export function backgroundedRunText(runId: string, elapsedMs: number) {
  const seconds = Math.round(elapsedMs / 1000)

  return `Still running after ${seconds} s: run ${runId} moved to the background, and its result arrives as a message. Don't poll it. \`tools.stopRun("${runId}")\` stops it.`
}

// The prompt that hands the model a background run's reply. Pictures cannot
// travel in a plugin's prompt, so it says how many stayed behind.
export function finishedBackgroundRunText(runId: string, { text, images }: RunReply) {
  const cut =
    text.length > BACKGROUND_REPLY_CHARACTERS
      ? `${text.slice(0, BACKGROUND_REPLY_CHARACTERS)}\n[cut at ${BACKGROUND_REPLY_CHARACTERS} characters]`
      : text
  const pictures =
    images.length === 0
      ? ''
      : `\n\n(${images.length} returned picture(s) cannot travel in this message: return them from a new run to see them.)`

  return `codemode: background run ${runId} finished.\n\n${cut}${pictures}`
}

export function parseServerReply(replyText: string) {
  // SAFETY: the codemode server writes every reply to `/run` and `/wait` as a ServerReply.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON from our own child process
  return JSON.parse(replyText) as ServerReply
}

// The `run` tool's result: the text alone, or it and the pictures as content
// blocks, the shape a plugin's tool hands the model images in.
export function runResult({ text, images }: RunReply) {
  return images.length === 0
    ? text
    : [
        { type: 'text', text },
        ...images.map(({ mediaType, base64 }) => ({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        })),
      ]
}

export function isRelayedTool(tool: string, customTools: readonly string[]) {
  return (
    !CONVERSATION_TOOLS.has(tool) &&
    !customTools.some((entry) =>
      entry.endsWith('*') ? tool.startsWith(entry.slice(0, -1)) : tool === entry,
    )
  )
}

// The reminder lists one deferred tool name per line under a sentence or two
// of framing. Drops the relayed names, and the whole reminder when none is left.
function isToolNameLine(line: string) {
  const trimmed = line.trim()

  return trimmed !== '' && !trimmed.includes(' ')
}

export function withoutRelayedToolNames(reminderText: string, customTools: readonly string[]) {
  const keptLines = reminderText
    .split('\n')
    .filter(
      (line) =>
        !isToolNameLine(line) ||
        (!isRelayedTool(line.trim(), customTools) && line.trim() !== RUN_TOOL_FULL_NAME),
    )

  return keptLines.some(isToolNameLine) ? keptLines.join('\n') : null
}
