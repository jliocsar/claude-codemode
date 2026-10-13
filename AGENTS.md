# claude-codemode

A Claude Code plugin (function-hooks API) that gives the model one tool, `mcp__codemode__run`, in
place of every tool that only moves data: built-ins (Read, Write, Edit, Bash, WebFetch, …) and all
MCP tools. The model writes a TypeScript async-function body; it runs in a Secure Exec VM and
reaches tools only through `tools.call(name, input)`, `tools.search(query)`,
`tools.zoom(filePath, region)` and `inputs`.

## Layout

```text
.claude-plugin/plugin.json   # manifest
.claude-plugin/types/        # written by Claude Code when it loads the plugin; gitignored, never edit
hooks/register.ts            # plugin side: registers `run`, hides relayed tools, relays tool calls
hooks/run-tool.ts            # `run`'s name, schema, description, the tools it relays; its result
hooks/codemode.test.ts       # `claude plugin test .`
codemode/server.ts           # Bun child: one VM, evaluates programs, socket server, zoom
codemode/relay.ts            # tool calls out as stdout lines, answers in from `/answer`
codemode/image.ts            # returned pictures out of the value, PDF page pictures, zoom
codemode/png.ts              # Bun.Image's RGBA PNGs to pixels and back, for the crop
codemode/catalog.ts          # tool input types from the generated d.ts, type-check prelude, search
codemode/server.spec.ts      # `bun test`; spec-harness.ts spawns the real server and plays the plugin
codemode/package.json        # runtime deps only (secure-exec, zod), `bun install`ed on first session start
package.json                 # dev tooling only: oxlint, oxfmt, begone-slop, typescript, @types/bun
```

## Two runtimes

- `hooks/` runs inside Claude Code's plugin environment: no Node, no npm packages, no `eval`, no
  WebAssembly. It can import other plugin files and types from `'claude-code'`, nothing else. Talk
  to the outside through `$` only. The API's types are in
  `.claude-plugin/types/claude-code/index.d.ts`; grep it for the event or noun at hand.
- `codemode/` is Bun ≥ 1.4 (for `Bun.Image`), spawned by the plugin as `bun server.ts` with
  `$.process.spawn` for the session's life. Use Bun's own APIs (`Bun.serve`, `Bun.file`,
  `Bun.Image`, `bun:test`) before `node:*` ones; zod stays because secure-exec takes only zod.

They talk in two directions: the server writes `CODEMODE_READY <socket>` and
`CODEMODE_TOOL_CALL {callId, input}` lines on stdout; the plugin `POST`s `/run`, `/wait` and `/answer` to
the server's Unix socket with `$.http.fetch({ socketPath })`; every reply is JSON, a run's
`{ text, images }`. Keep stdout for the protocol alone.

## Decisions that hold

- Conversation tools stay outside `run` (`CONVERSATION_TOOLS` in `hooks/run-tool.ts`): Agent,
  AskUserQuestion, Skill, ToolSearch, plan and worktree tools, Workflow. Their output is for the
  model to read, or they change the session. `CLAUDE_CODEMODE_CUSTOM_CONVERSATION_TOOLS` adds more
  (comma separated, trailing `*` matches by prefix, e.g. `mcp__executor__*`).
- Replace, never duplicate: relayed tools stay registered but are deferred (`tool.describe`) and
  cut from the deferred-tools reminder (`prompt.attachment`). Denying them or `--disallowedTools`
  removes them from the session, and then `$.tool.call` cannot reach them either.
- Relay through `$.tool.call`, not `$.mcp.call`: the latter skips permission prompts.
- `run` only stays in the prompt list because `$.ui.invalidate('tool.describe')` follows its
  registration.
- Strings with quotes, backticks or backslashes travel in `inputs`, never inlined into `code`.
- One VM per session; runs are serialized. Never use secure-exec's one-shot `evaluate` (~9 s).
- Host function schemas reject `z.unknown()`; use `z.looseObject({})`.
- Pictures reach the model only when the program returns them. The server swaps each one's
  `base64` for `[image N]` and keeps the rest of its record; `run` answers with a text block and
  `{ type: 'image', source: { type: 'base64', media_type, data } }` blocks. The engine refuses an
  MCP-style `{ content }` result, and `{ data, mimeType }` image blocks fail at the API.
- Read with `pages` hands a plugin the PDF's `outputDir`, never the page pictures: the server loads
  `page-N.*` from there after the relayed Read.
- `tools.zoom` relays Read first as its permission check and takes absolute paths only, so both
  name the same file. `Bun.Image` has no crop: `png.ts` slices its RGBA PNG output, then
  `Bun.Image` enlarges each pixel to a block up to Read's 2000 px long edge.
- No `idleTimeout` on `Bun.serve`: a Unix socket has none, and a run can last 30 minutes.
- `$.http.fetch` aborts any request after 30 s, undocumented. `/run` and `/wait` answer within
  `REPLY_WAIT_MS` (20 s) with the reply or `{ pendingRunId }`; the plugin polls `/wait` until done.
  A single fetch that outlived 30 s left the program running unseen, and the model retried it.
- Long commands are the session's own background tasks: relayed Bash takes `run_in_background`
  and the completion notice reaches the model. Never background anything inside the server.

## Commands

```sh
npm install                                # dev tooling (root); the plugin installs codemode/ itself
npm run lint                               # oxlint, type-aware, warnings fail
npm run fmt                                # oxfmt; `fmt:check` to verify
npm run typecheck                          # tsc 7 over hooks/ and codemode/
npm test                                   # both suites (needs bun on PATH)
claude plugin validate .
claude --plugin-dir .                      # load it in a session
```

`claude` may be a shell alias; scripts should call the binary on `PATH`.

## Lint

`.oxlintrc.json` extends `@jliocsar/begone-slop`'s preset; read the preset and its README rather
than restating them here. Fix rules in the begone-slop repo, never here. Off on purpose:
`begone-slop/no-comments` (comments are wanted) and `begone-slop/no-try-catch` (no Effect here).

`hooks/` has no schema library, so its two parses of the server's JSON (tool call lines, run
replies) are `SAFETY:` commented assertions with an inline disable. Everything the server receives
is parsed with zod.

Type-aware lint over all of `hooks/` can be killed (tsgolint `SIGTERM`, about 30 s in) by the
15,000-line API types. Then lint its files one at a time: `npx oxlint --type-aware --deny-warnings <file>`.

## Testing

- `hooks/*.test.ts` run against the engine via `claude plugin test`. Nothing sits beneath the
  plugin's hooks in a test, so add stand-in `on(...)` hooks for the engine's side.
- `codemode/server.spec.ts` runs on `bun test`; `spec-harness.ts` spawns the real server and plays
  the plugin with canned answers. A type check costs about 1.5 s per run, so keep the suite small.
  It is `.spec.ts` because `claude plugin test .` loads every `*.test.ts` under the plugin root as
  a hooks test, and cannot be scoped to `hooks/`.
