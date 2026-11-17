# claude-codemode

A Claude Code plugin that swaps every data-moving tool (Read, Write, Edit, Bash, WebFetch, MCP
tools, …) for one tool, `mcp__codemode__run`.

Instead of calling tools one at a time, the model writes a TypeScript async-function body. It runs
in a [Secure Exec](https://rivet.dev/secure-exec) VM, and its last expression is the result. Loops,
batching and filtering happen in the VM, so only the result lands in context. Long tool output
reaches the program whole, and Read pages through files past its size cap.

What a program can reach:

- `` $`git log -5 ${file}` `` — Bun Shell's `$` (quoting, `.text()`, `.json()`, `.lines()`,
  `.nothrow()`, `.cwd()`), with every command run through Claude Code's Bash tool, not Bun.
- `read(path)`, `write(path, content)`, `edit(path, old, new, { all })` over Read, Write and Edit.
  Relative paths start at the session's directory, and a file is read first when the tool asks.
- `keep.get/set/delete`: JSON values that carry from one run to the next.
- `tools.call(name, input)` for any other tool, `tools.search(query)`, `tools.zoom(…)`,
  `tools.runs()`, `tools.stopRun(id)`, and `inputs`.

Programs are type-checked against each tool's real input type before they run, by a TypeScript
language service kept warm in the server (a few ms per check).

Pictures work as they do with Read: a program that returns Read's result for an image (or PDF
pages) shows it to the model. `tools.zoom(filePath, { x, y, width, height })` shows part of an
image file at its own pixels, each enlarged to a block, for detail Read scales away. Every relayed call still goes through Claude Code's
usual permissions.

Nothing times out unless you set `CLAUDE_CODEMODE_MAX_RUN_MS`. A run still going after two minutes
moves to the background, the way a long Bash command does: the model gets its id at once and its
result as a message when it ends, with any pictures it returned saved as files.
`CLAUDE_CODEMODE_BACKGROUND_AFTER_MS` sets another wait. Interrupting a run stops its program. If
the server or its VM dies (killed, out of memory, a crashed sidecar), it's started again on its
own, with no need to restart the session.

The VM's temporary files live in `$TMPDIR/claude-codemode/<server pid>/`, removed when the server
stops, and swept by the next server when it was killed.

With Claude Code's own Code Mode on (`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`, its `REPL` tool),
codemode stays off for the session.

## Permissions and hooks

Every relayed call goes through your `deny` and `ask` rules and `PreToolUse` hooks under the tool's
own name, such as `Bash`. To check the code itself, match `mcp__codemode__run` in a `PreToolUse`
hook and read `tool_input.code`. ``$`…`.cwd(dir)`` reaches Bash rules and hooks as
`cd 'dir' && …`, so a hook that allows or blocks commands should check each part of a compound
command, as Bash rules do.

Conversation tools (Agent, Skill, AskUserQuestion, plan and worktree tools, …) stay outside `run`.
Add more with `CLAUDE_CODEMODE_CUSTOM_CONVERSATION_TOOLS` (comma separated, trailing `*` matches by
prefix, e.g. `mcp__executor__*`).

## Install

Needs [Bun](https://bun.com) ≥ 1.4 on `PATH`.

```sh
claude plugin marketplace add jliocsar/claude-codemode
claude plugin install codemode@claude-codemode
```

Or from inside a session: `/plugin marketplace add jliocsar/claude-codemode`, then
`/plugin install codemode@claude-codemode`.

The server's dependencies install themselves on the first session start.
