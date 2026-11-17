// What a program sees as its globals: `tools`, `$`, `read`, `write`, `edit`
// and `keep`, built inside the VM over the frozen `codemode` host collection.
// Everything a program sends is parsed on the host (vm.ts, shorthands.ts).
//
// guestApi runs in the guest, not here: vm.ts injects its source text into
// every program. So it may use nothing from outside its own body, and its
// types are only for this repo's checks.

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

// A started host call. `value` is never sent: it carries the type of what the call settles with.
type Ticket<Value> = { ticket: string; value?: Value }

type Settled<Value> =
  | { done: false }
  | { done: true; value: Value; error?: undefined }
  | { done: true; error: string }

type ToolReply = { text: string; isError: boolean; result: Json }

type ShellOutput = { stdout: string; stderr: string; exitCode: number }

type ShellRequest = { runId: string; strings: string[]; valuesJson: string; cwd?: string }

type ShellValue = string | number | boolean | (string | number | boolean)[] | { raw: string }

type ZoomRegion = { x: number; y: number; width: number; height: number }

type FoundTool = { name: string; description: string; input: string }

type RunningRun = { id: string; seconds: number; code: string }

// The host collection Secure Exec defines in the guest (vm.ts).
declare const codemode: {
  call: (input: {
    runId: string
    name: string
    input: Record<string, Json>
  }) => Promise<Ticket<ToolReply>>
  zoom: (input: {
    runId: string
    filePath: string
    region: ZoomRegion
  }) => Promise<Ticket<Record<string, Json>>>
  shell: (input: ShellRequest) => Promise<Ticket<ShellOutput>>
  read: (input: {
    runId: string
    path: string
    offset?: number
    limit?: number
  }) => Promise<Ticket<string>>
  write: (input: { runId: string; path: string; content: string }) => Promise<Ticket<null>>
  edit: (input: {
    runId: string
    path: string
    oldText: string
    newText: string
    all: boolean
  }) => Promise<Ticket<null>>
  wait: <Value>(input: Ticket<Value>) => Promise<Settled<Value>>
  search: (input: { runId: string; query: string }) => Promise<FoundTool[]>
  runs: (input: Record<string, never>) => Promise<RunningRun[]>
  stopRun: (input: { runId: string }) => Promise<boolean>
  keepGet: (input: { key: string }) => Promise<{ found: boolean; value: Json }>
  keepSet: (input: { key: string; json: string }) => Promise<null>
  keepDelete: (input: { key: string }) => Promise<boolean>
}

export function guestApi(runId: string) {
  const settled = async <Value>(started: Promise<Ticket<Value>>) => {
    const { ticket } = await started

    for (;;) {
      const round = await codemode.wait<Value>({ ticket })

      if (round.done) {
        if (round.error !== undefined) {
          throw new Error(round.error)
        }

        return round.value
      }
    }
  }

  // Bun Shell's promise. The command runs once, on the next tick, unless
  // `.cwd()` made a new one from it first; `.nothrow()` and `.quiet()` read
  // the same run.
  const shell = (request: ShellRequest) => {
    let running: Promise<ShellOutput> | undefined
    let superseded = false

    const run = () => {
      running ??= settled(codemode.shell(request))

      return running
    }

    queueMicrotask(() => {
      if (!superseded) {
        // Awaited or not, it runs; whoever awaits it sees how it failed.
        // oxlint-disable-next-line promise/prefer-await-to-then -- started unawaited, its failure is the awaiter's to see
        run().catch(() => null)
      }
    })

    const view = (nothrow: boolean) => {
      const finished = async () => {
        const output = await run()

        if (output.exitCode !== 0 && !nothrow) {
          const message = `exit code ${output.exitCode}: ${output.stdout.slice(-2000)}`

          throw Object.assign(new Error(message), output)
        }

        return output
      }

      return {
        then: <Result>(
          onFulfilled: ((output: ShellOutput) => Result) | undefined,
          onRejected: ((reason: Error) => Result) | undefined,
          // oxlint-disable-next-line promise/prefer-await-to-then -- this is the thenable's own `then`
        ) => finished().then(onFulfilled, onRejected),
        text: async () => (await finished()).stdout,
        json: async () => {
          // oxlint-disable-next-line typescript/no-unsafe-assignment -- the command's output parsed as JSON is JSON; the program reads its shape
          const parsed: Json = JSON.parse((await finished()).stdout)

          return parsed
        },
        lines: async () => {
          const { stdout } = await finished()

          return stdout === '' ? [] : stdout.replace(/\n$/u, '').split('\n')
        },
        nothrow: () => view(true),
        quiet: () => view(nothrow),
        cwd: (directory: string) => {
          superseded = true

          return shell({ ...request, cwd: directory })
        },
      }
    }

    return view(false)
  }

  const $ = (strings: TemplateStringsArray, ...values: ShellValue[]) =>
    shell({ runId, strings: [...strings], valuesJson: JSON.stringify(values) })

  const keep = {
    get: async (key: string) => {
      const { found, value } = await codemode.keepGet({ key })

      return found ? value : undefined
    },
    set: async (key: string, value: Json) => {
      await codemode.keepSet({ key, json: JSON.stringify(value) })
    },
    delete: (key: string) => codemode.keepDelete({ key }),
  }

  const tools = {
    call: (name: string, input: Record<string, Json>) =>
      settled(codemode.call({ runId, name, input })),
    search: (query: string) => codemode.search({ runId, query }),
    zoom: (filePath: string, region: ZoomRegion) =>
      settled(codemode.zoom({ runId, filePath, region })),
    runs: () => codemode.runs({}),
    stopRun: (otherRunId: string) => codemode.stopRun({ runId: otherRunId }),
  }

  return {
    tools,
    $,
    read: (path: string, options: { offset?: number; limit?: number } = {}) =>
      settled(codemode.read({ runId, path, ...options })),
    write: (path: string, content: string) => settled(codemode.write({ runId, path, content })),
    edit: (path: string, oldText: string, newText: string, options: { all?: boolean } = {}) =>
      settled(codemode.edit({ runId, path, oldText, newText, all: options.all === true })),
    keep,
  }
}
