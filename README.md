# claude-codemode

A Claude Code plugin that swaps every data-moving tool (Read, Write, Edit, Bash, WebFetch, MCP
tools, …) for one tool, `mcp__codemode__run`.

Instead of calling tools one at a time, the model writes a TypeScript async-function body. It runs
in a [Secure Exec](https://rivet.dev/secure-exec) VM and reaches tools only through
`tools.call(name, input)`, `tools.search(query)` and `inputs`. Loops, batching and filtering happen
in the VM, so only the result lands in context. Every relayed call still goes through Claude Code's
usual permissions.

Conversation tools (Agent, Skill, AskUserQuestion, plan and worktree tools, …) stay outside `run`.
Add more with `CLAUDE_CODEMODE_CUSTOM_CONVERSATION_TOOLS` (comma separated, trailing `*` matches by
prefix, e.g. `mcp__executor__*`).

## Install

Needs Node ≥ 22.18 and npm on `PATH`.

```sh
claude plugin marketplace add jliocsar/claude-codemode
claude plugin install codemode@claude-codemode
```

Or from inside a session: `/plugin marketplace add jliocsar/claude-codemode`, then
`/plugin install codemode@claude-codemode`.

The server's dependencies install themselves on the first session start.
