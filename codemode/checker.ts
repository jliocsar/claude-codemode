// The program's text on the host, before the VM sees it: type-checked by a
// TypeScript language service kept warm for the server's life, its last
// expression made the value, and its types stripped.
//
// Secure Exec's own check boots a compiler per call, ~1.4 s even for one line
// (measured); a warm service answers in milliseconds. It only reads the text,
// never runs it, so the VM stays the one place a program runs.

import ts from 'typescript'

const PROGRAM_FILE = '/codemode/program.ts'

// As Secure Exec's check had them (measured): the default libs, DOM included,
// and not strict, so a caught error's fields read without a cast.
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
  // TypeScript 6 makes strict the default.
  strict: false,
  types: [],
  noEmit: true,
  skipLibCheck: true,
}

const libSnapshots = new Map<string, ts.IScriptSnapshot | undefined>()
const languageService = ts.createLanguageService({
  getCompilationSettings: () => COMPILER_OPTIONS,
  getScriptFileNames: () => [PROGRAM_FILE],
  getScriptVersion: (fileName) => (fileName === PROGRAM_FILE ? String(programVersion) : '0'),
  getScriptSnapshot: (fileName) =>
    fileName === PROGRAM_FILE ? ts.ScriptSnapshot.fromString(programText) : libSnapshot(fileName),
  getCurrentDirectory: () => '/',
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: (fileName) => fileName === PROGRAM_FILE || ts.sys.fileExists(fileName),
  readFile: (fileName) => (fileName === PROGRAM_FILE ? programText : ts.sys.readFile(fileName)),
})

// The lib files never change: each is read and parsed once.
function libSnapshot(fileName: string) {
  if (!libSnapshots.has(fileName)) {
    const text = ts.sys.readFile(fileName)
    libSnapshots.set(fileName, text === undefined ? undefined : ts.ScriptSnapshot.fromString(text))
  }

  return libSnapshots.get(fileName)
}

// The program's type errors, numbered by its own lines. `prelude` declares
// what the program sees and opens the function its code is the body of.
export function typeErrors(prelude: string, code: string) {
  programText = `${prelude}${code}\n}\nexport {}\n`
  programVersion += 1
  const preludeLineCount = prelude.split('\n').length - 1
  const sourceFile = languageService.getProgram()?.getSourceFile(PROGRAM_FILE)
  const diagnostics = [
    ...languageService.getSyntacticDiagnostics(PROGRAM_FILE),
    ...languageService.getSemanticDiagnostics(PROGRAM_FILE),
  ]

  return diagnostics
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const fileLine =
        sourceFile === undefined || diagnostic.start === undefined
          ? 0
          : sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')

      return `line ${fileLine - preludeLineCount}: TS${diagnostic.code} ${message}`
    })
}

// The code with its last statement returned when that is an expression, as a
// REPL shows it; an explicit `return` works as before.
export function withLastExpressionReturned(code: string) {
  const sourceFile = ts.createSourceFile('body.ts', code, ts.ScriptTarget.ESNext, true)
  const last = sourceFile.statements.at(-1)

  if (last === undefined || !ts.isExpressionStatement(last)) {
    return code
  }

  const { expression } = last

  return `${code.slice(0, expression.getStart(sourceFile))}return (${code.slice(expression.getStart(sourceFile), expression.end)});${code.slice(last.end)}`
}

// An expression in TypeScript to one in JavaScript, types stripped: without
// the `"use strict";` TypeScript puts first and the statement's closing `;`,
// neither of which an evaluated expression can hold.
export function stripTypes(expression: string) {
  return ts
    .transpileModule(expression, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve },
      reportDiagnostics: false,
    })
    .outputText.replace(/^"use strict";\n/u, '')
    .trimEnd()
    .replace(/;$/u, '')
}

// Parses the libs once at start, so the first run doesn't pay for it.
export function warmUpChecker() {
  typeErrors('async function run() {\n', 'const warm: number = 1')
}

// The program the language service checks now, and its version.
let programText = ''
let programVersion = 0
