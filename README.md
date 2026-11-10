# claude-codemode

A Claude Code plugin that swaps every data-moving tool (Read, Write, Edit, Bash, WebFetch, MCP
tools, …) for one tool, `mcp__codemode__run`.

Instead of calling tools one at a time, the model writes a TypeScript async-function body. It runs
in a [Secure Exec](https://rivet.dev/secure-exec) VM and reaches tools only through
`tools.call(name, input)`, `tools.search(query)`, `tools.zoom(…)`, `tools.stopRun(id)` and
`inputs`. Loops, batching and filtering happen in the VM, so only the result lands in context. Long
tool output reaches the program whole, and Read pages through files past its size cap.

Pictures work as they do with Read: a program that returns Read's result for an image (or PDF
pages) shows it to the model. `tools.zoom(filePath, { x, y, width, height })` shows part of an
image file at its own pixels, each enlarged to a block, for detail Read scales away. Every relayed call still goes through Claude Code's
usual permissions.

Nothing times out. A run still going after two minutes moves to the background, the way a long
Bash command does: the model gets its id at once and its result as a message when it ends.
`CLAUDE_CODEMODE_BACKGROUND_AFTER_MS` sets another wait. Interrupting a run stops its program. If
the server or its VM dies (killed, out of memory, a crashed sidecar), it's started again on its
own, with no need to restart the session.

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
