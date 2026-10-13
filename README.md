# claude-codemode

A Claude Code plugin that swaps every data-moving tool (Read, Write, Edit, Bash, WebFetch, MCP
tools, …) for one tool, `mcp__codemode__run`.

Instead of calling tools one at a time, the model writes a TypeScript async-function body. It runs
in a [Secure Exec](https://rivet.dev/secure-exec) VM and reaches tools only through
`tools.call(name, input)`, `tools.search(query)` and `inputs`. Loops, batching and filtering happen
in the VM, so only the result lands in context.

Pictures work as they do with Read: a program that returns Read's result for an image (or PDF
pages) shows it to the model. `tools.zoom(filePath, { x, y, width, height })` shows part of an
image file at its own pixels, each enlarged to a block, for detail Read scales away. Every relayed call still goes through Claude Code's
usual permissions.

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
