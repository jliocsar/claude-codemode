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

export const RUN_TOOL_DESCRIPTION = `Run a TypeScript program against Claude Code's tools in an isolated VM. This is how you read, write and edit files, run shell commands, fetch and search the web, and call MCP servers: those tools are reachable only from here, unless you have them directly.

Loop, branch, batch and filter in one call, and return only what matters. \`code\` is the body of an async function: await the calls and \`return\` a JSON value. You read the value alone (a string as is), then any console.log output; a failed run reads \`run failed: <why>\`.

\`\`\`ts
declare const tools: {
  /**
   * Run one tool by name, e.g. "Read", "Edit", "Bash", "WebFetch", "mcp__<server>__<tool>".
   * \`result\`: the tool's own record (Read's file, Bash's streams), else \`text\` parsed when JSON, else \`text\`.
   * Long output comes back whole in both, and Read pages through a file past its size cap.
   */
  call(name: string, input: object): Promise<{ text: string; isError: boolean; result: unknown }>
  /** Find tools by words in their name or description; each comes with its input type. "" lists them all. */
  search(query: string): Promise<{ name: string; description: string; input: string }[]>
  /**
   * Part of an image file at its own pixels, each one enlarged to a block, for detail Read scales away.
   * \`region\` is in the file's pixels: Read's \`result.file.dimensions\` maps what you saw to them.
   */
  zoom(filePath: string, region: { x: number; y: number; width: number; height: number }): Promise<object>
  /** Stops a run that moved to the background, by its id. */
  stopRun(runId: string): Promise<boolean>
}
declare const inputs: any
\`\`\`

Return a picture to see it: Read's \`result\` for an image file or PDF pages, or what \`tools.zoom\` gives, anywhere in the value. Its \`base64\` reads as \`[image N]\`, the rest of its record as is, and the images come after the text. Pictures you don't return never reach you.

Search before calling a tool whose input you don't know. Common ones: Read { file_path, offset?, limit? }, Write { file_path, content }, Edit { file_path, old_string, new_string, replace_all? }, Bash { command, timeout?, run_in_background? }.
A run never times out, and runs can go side by side. One still going after 2 minutes moves to the background: you get its id at once and its result later as a message, so carry on meanwhile and don't poll for it. For one long shell command, Bash's run_in_background is lighter still.
Put file contents, edit strings and any text with quotes, backticks or backslashes in \`inputs\` and read them as \`inputs.name\`. Never write them inline in \`code\`.
The VM has no network and no real filesystem: \`tools\` is the only way out, and every call goes through the usual permissions.
The code is type-checked against each tool's real input type first. A type error comes back without anything running.`

export function backgroundedRunText(runId: string, elapsedMs: number) {
  const seconds = Math.round(elapsedMs / 1000)

  return `Still running after ${seconds} s, so run ${runId} moved to the background. Its result arrives as a message when it ends: carry on, and don't poll or sleep for it. \`tools.stopRun("${runId}")\` stops it.`
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
