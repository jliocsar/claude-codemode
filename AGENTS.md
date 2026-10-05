# claude-codemode

A Claude Code plugin (function-hooks API) that gives the model one tool, `mcp__codemode__run`, in
place of every tool that only moves data: built-ins (Read, Write, Edit, Bash, WebFetch, …) and all
MCP tools. The model writes a TypeScript async-function body; it runs in a Secure Exec VM and
reaches tools only through `tools.call(name, input)`, `tools.search(query)` and `inputs`.

## Layout

```text
.claude-plugin/plugin.json   # manifest
.claude-plugin/types/        # written by Claude Code when it loads the plugin; gitignored, never edit
hooks/register.ts            # plugin side: registers `run`, hides relayed tools, relays tool calls
hooks/codemode.test.ts       # `claude plugin test .`
codemode/server.ts           # Node child: one VM, evaluates programs, socket server, relay
codemode/catalog.ts          # tool input types from the generated d.ts, type-check prelude, search
codemode/server.spec.ts      # spawns the real server; `node --test`
codemode/package.json        # runtime deps only (secure-exec, zod), installed on first session start
package.json                 # dev tooling only: oxlint, oxfmt, begone-slop, typescript
```

## Two runtimes

- `hooks/` runs inside Claude Code's plugin environment: no Node, no npm packages, no `eval`, no
  WebAssembly. It can import other plugin files and types from `'claude-code'`, nothing else. Talk
  to the outside through `$` only. The API's types are in
  `.claude-plugin/types/claude-code/index.d.ts`; grep it for the event or noun at hand.
- `codemode/` is plain Node ≥ 22.18 (runs `.ts` by type stripping, so erasable syntax only). It is
  spawned by the plugin with `$.process.spawn` for the session's life.

They talk in two directions: the server writes `CODEMODE_READY <socket>` and
`CODEMODE_TOOL_CALL {callId, input}` lines on stdout; the plugin `POST`s `/run` and `/answer` to
the server's Unix socket with `$.http.fetch({ socketPath })`. Keep stdout for the protocol alone.

## Decisions that hold

- Conversation tools stay outside `run` (`CONVERSATION_TOOLS` in `hooks/register.ts`): Agent,
  AskUserQuestion, Skill, ToolSearch, plan and worktree tools, Workflow. Their output is for the
  model to read, or they change the session.
- Replace, never duplicate: relayed tools stay registered but are deferred (`tool.describe`) and
  cut from the deferred-tools reminder (`prompt.attachment`). Denying them or `--disallowedTools`
  removes them from the session, and then `$.tool.call` cannot reach them either.
- Relay through `$.tool.call`, not `$.mcp.call`: the latter skips permission prompts.
- `run` only stays in the prompt list because `$.ui.invalidate('tool.describe')` follows its
  registration.
- Strings with quotes, backticks or backslashes travel in `inputs`, never inlined into `code`.
- One VM per session; runs are serialized. Never use secure-exec's one-shot `evaluate` (~9 s).
- Host function schemas reject `z.unknown()`; use `z.looseObject({})`.

## Commands

```sh
npm install                                # dev tooling (root); the plugin installs codemode/ itself
npm run lint                               # oxlint, type-aware, warnings fail
npm run fmt                                # oxfmt; `fmt:check` to verify
npm run typecheck                          # tsc 7 over hooks/ and codemode/
npm test                                   # both suites
claude plugin validate .
claude --plugin-dir .                      # load it in a session
```

`claude` may be a shell alias; scripts should call the binary on `PATH`.

## Lint

`.oxlintrc.json` extends `@jliocsar/begone-slop`'s preset; read the preset and its README rather
than restating them here. Fix rules in the begone-slop repo, never here. Off on purpose:
`begone-slop/no-comments` (comments are wanted) and `begone-slop/no-try-catch` (no Effect here).

`hooks/` has no schema library, so its one parse of the server's stdout JSON is a `SAFETY:`
commented assertion with an inline disable. Everything the server receives is parsed with zod.

## Testing

- `hooks/*.test.ts` run against the engine via `claude plugin test`. Nothing sits beneath the
  plugin's hooks in a test, so add stand-in `on(...)` hooks for the engine's side.
- `codemode/server.spec.ts` spawns the real server and plays the plugin. A type check costs about
  1.5 s per run, so keep the suite small. It is `.spec.ts` because `claude plugin test .` loads
  every `*.test.ts` under the plugin root as a hooks test, and cannot be scoped to `hooks/`.
