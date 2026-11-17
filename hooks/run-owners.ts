// Which runs a subagent started, and what that changes. A plugin's
// `$.prompt.submit` and `$.tool.call` both act in the main loop, never in a
// subagent's: a background run's reply, and the completion notice of a
// relayed Bash `run_in_background`, both landed in the parent session. So a
// subagent's run never moves to the background, and its relayed Bash runs in
// the foreground.

import type { EngineInterface } from 'claude-code'

type ToolCallInput = Parameters<EngineInterface['tool']['call']>[0]

// Bash's own longest timeout: past its default 2 minutes, the engine moves a
// command to the background on its own, and its notice would leak too.
const SUBAGENT_BASH_TIMEOUT_MS = 600_000

const SUBAGENT_BACKGROUND_REFUSAL =
  'run_in_background from code in a subagent: its notice would reach the parent session, not you. Run the command without it: the run waits for it, however long it takes.'

// The subagent that started each run still going; absent for the main loop's runs.
const runAgents = new Map<string, string>()

export function rememberRunAgent(runId: string, agentId: string | undefined) {
  if (agentId !== undefined) {
    runAgents.set(runId, agentId)
  }
}

export function forgetRunAgent(runId: string) {
  runAgents.delete(runId)
}

export function isSubagentRun(runId: string) {
  return runAgents.has(runId)
}

// The call as a subagent's run may make it: Bash in the foreground, with its
// longest timeout unless the program set one; a refusal for `run_in_background`.
export function subagentCall(
  input: ToolCallInput,
): { input: ToolCallInput; refusal?: undefined } | { refusal: string } {
  if (input.tool !== 'Bash') {
    return { input }
  }

  if (input.run_in_background === true) {
    return { refusal: SUBAGENT_BACKGROUND_REFUSAL }
  }

  return { input: { ...input, timeout: input.timeout ?? SUBAGENT_BASH_TIMEOUT_MS } }
}
