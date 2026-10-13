// The tools a program may call: their input types, read from what Claude Code
// generates, the type-check prelude built from them, and search over them.

import { z } from 'zod'

export type CatalogEntry = z.infer<typeof catalogEntrySchema>

const SEARCH_RESULT_LIMIT = 25
const SEARCH_DESCRIPTION_CHARACTERS = 300
const UNTYPED_INPUT = 'Record<string, unknown>'

// Claude Code writes these beside the plugin when it loads it: every built-in
// and connected MCP tool's input, as TypeScript.
const TOOL_TYPE_FILES = [
  {
    path: '../.claude-plugin/types/claude-code-tools/index.d.ts',
    interfaceName: 'BuiltinToolInputs',
  },
  { path: '../.claude-plugin/types/claude-code-mcp/index.d.ts', interfaceName: 'McpToolInputs' },
]

export const catalogEntrySchema = z.object({ name: z.string(), description: z.string() })

// Reads `interface <name> { Tool: { ... } }` entries out of a generated d.ts:
// tool name → its input type as source text.
function parseToolInputTypes(declarationText: string, interfaceName: string) {
  const parsedToolInputTypes = new Map<string, string>()
  const lines = declarationText.split('\n')
  const interfaceStart = lines.findIndex((line) => line.trim() === `interface ${interfaceName} {`)

  if (interfaceStart < 0) {
    return parsedToolInputTypes
  }

  let openEntry: { name: string; body: string[] } | undefined

  for (const line of lines.slice(interfaceStart + 1)) {
    if (line === '  }') {
      break
    }

    if (openEntry === undefined) {
      const entryStart = /^ {4}("[^"]+"|[\w$]+): (.*)$/u.exec(line)

      if (entryStart !== null) {
        const name = entryStart[1]!.replace(/^"|"$/gu, '')
        const rest = entryStart[2]!

        if (rest === '{') {
          openEntry = { name, body: ['{'] }
        } else {
          parsedToolInputTypes.set(name, rest)
        }
      }
    } else {
      openEntry.body.push(line.slice(4))

      if (line === '    }') {
        parsedToolInputTypes.set(openEntry.name, openEntry.body.join('\n'))
        openEntry = undefined
      }
    }
  }

  return parsedToolInputTypes
}

export async function loadToolInputTypes(): Promise<ReadonlyMap<string, string>> {
  const loaded = await Promise.all(
    TOOL_TYPE_FILES.map(async ({ path, interfaceName }) => {
      const declarationText = await readDeclarationText(path)

      return [...parseToolInputTypes(declarationText, interfaceName)]
    }),
  )

  return new Map(loaded.flat())
}

// Missing until Claude Code has loaded the plugin once; every tool is untyped then.
async function readDeclarationText(path: string) {
  try {
    return await Bun.file(new URL(path, import.meta.url)).text()
  } catch {
    return ''
  }
}

export function buildTypeCheckPrelude(
  catalog: readonly CatalogEntry[],
  toolInputTypes: ReadonlyMap<string, string>,
) {
  return [
    "/** `result`: the tool's own record (Read's file, Bash's streams), else `text` parsed when JSON, else `text`. */",
    'type ToolResult = { text: string; isError: boolean; result: unknown }',
    'type FoundTool = { name: keyof ToolInputs; description: string; input: string }',
    'type ImageRegion = { x: number; y: number; width: number; height: number }',
    "type ZoomedImage = { type: 'image'; file: { base64: string; type: 'image/png'; dimensions: { originalWidth: number; originalHeight: number; displayWidth: number; displayHeight: number } }; region: ImageRegion }",
    'interface ToolInputs {',
    ...catalog.map(
      ({ name }) => `  ${JSON.stringify(name)}: ${toolInputTypes.get(name) ?? UNTYPED_INPUT}`,
    ),
    '}',
    'declare const tools: {',
    '  call<Name extends keyof ToolInputs>(name: Name, input: ToolInputs[Name]): Promise<ToolResult>',
    '  search(query: string): Promise<FoundTool[]>',
    '  zoom(filePath: string, region: ImageRegion): Promise<ZoomedImage>',
    '}',
    'declare const inputs: any',
    'async function run() {',
    '',
  ].join('\n')
}

export function searchCatalog(
  catalog: readonly CatalogEntry[],
  toolInputTypes: ReadonlyMap<string, string>,
  query: string,
) {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean)
  const matches = catalog.filter(({ name, description }) =>
    words.every((word) => `${name} ${description}`.toLowerCase().includes(word)),
  )

  // An empty query lists every tool, as `run`'s description promises; words cap the hits.
  return (words.length === 0 ? matches : matches.slice(0, SEARCH_RESULT_LIMIT)).map(
    ({ name, description }) => ({
      name,
      description: (description.split('\n')[0] ?? '').slice(0, SEARCH_DESCRIPTION_CHARACTERS),
      input: toolInputTypes.get(name) ?? UNTYPED_INPUT,
    }),
  )
}
