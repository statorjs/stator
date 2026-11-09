import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { syncTypes } from '../../build/index.ts'
import { contractErrors, reachIslands } from '../../build/library-islands.ts'
import { sourceId } from '../../build/source-id.ts'
import type { VirtualSource } from '../../build/sync.ts'
import { CompileError, compile, compileWarnings, regionResolverFor } from '../../compiler/index.ts'
import { decodeMappings, type SourceMapV3 } from '../../compiler/source-map.ts'
import type { CliContext } from '../run.ts'

export interface CheckOptions {
  /** Directory whose `.stator` files are checked, relative to the root. */
  dir?: string
  /** Routes the contract check walks from, relative to the root. */
  routesDir?: string
}

/**
 * Validate the WHOLE stack — server machines/routes/lib plus the generated
 * `.stator` types — with no output. `stator build` and `stator build:lib` run
 * it first, so a broken server import or island script fails the build
 * instead of shipping.
 *
 * Four steps: (1) `syncTypes` regenerates each `.stator.d.ts` + the virtual TSX
 * the language server typechecks for every `.stator` under `opts.dir` (default
 * the root), written under `<root>/.stator` either way; (2) every one of those
 * files goes through the real compiler — the same call `dev` makes on import
 * and the editor makes per edit, so all three reject the same inputs; (3)
 * every compiled component the routes reach in a package carries this
 * compiler's contract stamp (`library-islands.ts`), walking from
 * `opts.routesDir` (default `<dir>/routes`), skipped with a note when that
 * directory doesn't exist; (4) a `tsc --noEmit`-equivalent pass via the
 * TypeScript API over the nearest `tsconfig.json`.
 * Compiler warnings print alongside the compile step but don't fail the check.
 */
export async function checkStack(root: string, opts: CheckOptions = {}): Promise<void> {
  const dir = opts.dir ? resolve(root, opts.dir) : root
  const { written, files, virtual } = await syncTypes(root, { dir })

  const { errors: compileErrors, warnings, clients } = await compileAll(root, files)
  const origins = new Map<string, Origin>()
  for (const [path, v] of virtual) origins.set(path, virtualOrigin(v))
  for (const c of clients) {
    const target = join(root, '.stator', 'check', `${relative(root, c.file)}.client.check.tsx`)
    await writeFile(target, c.code)
    origins.set(target.replace(/\\/g, '/'), clientOrigin(c))
  }
  if (warnings.length > 0) {
    process.stderr.write(`${warnings.join('\n\n')}\n\n`)
  }
  if (compileErrors.length > 0) {
    process.stderr.write(`${compileErrors.join('\n\n')}\n\n`)
  }

  const routesDir = opts.routesDir ? resolve(root, opts.routesDir) : join(dir, 'routes')
  let stampErrors: string[] = []
  if (existsSync(routesDir)) {
    const reach = await reachIslands({ routesDir, baseDir: root, shells: new Map() })
    stampErrors = await contractErrors(reach.packageComponents.values())
    if (stampErrors.length > 0) process.stderr.write(`${stampErrors.join('\n\n')}\n\n`)
  } else {
    process.stdout.write(`  note: no ${relPath(root, routesDir)}/ — contract check skipped\n`)
  }

  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) throw new Error(`no tsconfig.json found at or above ${root}`)

  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    { noEmit: true },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, ts.sys.newLine))
      },
    },
  )
  if (!parsed) throw new Error(`could not parse ${configPath}`)

  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  // A generated check file is never emitted, so a `declaration: true`
  // tsconfig's declaration diagnostics don't apply to it.
  const undeclared = new Set<ts.Diagnostic>()
  for (const sf of program.getSourceFiles()) {
    if (!origins.has(sf.fileName.replace(/\\/g, '/'))) continue
    for (const d of program.getDeclarationDiagnostics(sf)) undeclared.add(d)
  }
  const diagnostics = dedupe(
    [...program.getConfigFileParsingDiagnostics(), ...ts.getPreEmitDiagnostics(program)]
      .filter((d) => !undeclared.has(d))
      .map((d) => toStatorSource(d, origins)),
  )

  if (diagnostics.length > 0) {
    process.stderr.write(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getNewLine: () => ts.sys.newLine,
      }),
    )
  }
  const n = compileErrors.length + stampErrors.length + diagnostics.length
  if (n > 0) {
    throw new Error(`typecheck failed with ${n} error${n === 1 ? '' : 's'}`)
  }

  // Split the program into the app's own files vs. framework/lib overhead so the
  // count reads honestly: most of the program is @statorjs/stator's shipped source
  // (raw TS — typechecked, not `skipLibCheck`-skipped) plus TS libs, not your code.
  // App files = under the app root and outside node_modules; the rest is framework
  // + libs. The same split holds for an installed app (framework source lives under
  // `root/node_modules`, which the node_modules test excludes).
  const rootPrefix = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  const sourceFiles = program.getSourceFiles()
  const appFiles = sourceFiles.filter(
    (sf) => sf.fileName.startsWith(rootPrefix) && !sf.fileName.includes('/node_modules/'),
  ).length
  const frameworkFiles = sourceFiles.length - appFiles

  const w = warnings.length
  const warned = w > 0 ? `, ${w} warning${w === 1 ? '' : 's'}` : ''
  process.stdout.write(
    `stator check: ok — ${written} .stator.d.ts, ${appFiles} app files (${frameworkFiles} framework files)${warned}\n`,
  )
}

/** Where a generated check file's diagnostics land in its `.stator` source. */
interface Origin {
  file: string
  text: string
  /** Generated span → source span, or undefined for code the compiler
   *  invented. */
  locate(start: number, length: number, generated: string): [number, number] | undefined
}

function virtualOrigin(v: VirtualSource): Origin {
  return {
    file: v.file,
    text: v.text,
    locate(start, length) {
      const m = v.mappings.find(
        (m) => start >= m.generatedOffset && start < m.generatedOffset + m.length,
      )
      if (!m) return undefined
      return [
        m.sourceOffset + (start - m.generatedOffset),
        Math.min(length, m.generatedOffset + m.length - start),
      ]
    },
  }
}

/** A position in a compiled client module, through its source map. A segment
 *  copying source verbatim keeps the column offset inside it; a generated
 *  line (an event listener the template wires) lands on the directive. */
function clientOrigin(c: CompiledClient): Origin {
  const lines = decodeMappings(c.map.mappings)
  const starts = lineStarts(c.text)
  return {
    file: c.file,
    text: c.text,
    locate(start, length, generated) {
      const genStarts = lineStarts(generated)
      const line = lineAt(genStarts, start)
      const col = start - genStarts[line]!
      let seg: [number, number, number] | undefined
      for (const s of lines[line] ?? []) if (s[0] <= col) seg = s
      if (!seg) return undefined
      const [gen, srcLine, srcCol] = seg
      const base = (starts[srcLine] ?? 0) + srcCol
      const delta = col - gen
      const lineEnd = c.text.indexOf('\n', base)
      const verbatim =
        generated.slice(start - delta, start + length) === c.text.slice(base, base + delta + length)
      if (verbatim) return [base + delta, length]
      const end = lineEnd === -1 ? c.text.length : lineEnd
      const word = /^[^\s=]+=\{[^}]*\}|^\S+/.exec(c.text.slice(base, end))
      return [base, word ? word[0].length : 0]
    },
  }
}

function lineStarts(text: string): number[] {
  const out = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(i + 1)
  return out
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** A diagnostic inside a generated check file, moved onto the `.stator` file
 *  it came from, so the report names the source line. */
function toStatorSource(d: ts.Diagnostic, origins: Map<string, Origin>): ts.Diagnostic {
  if (!d.file || d.start === undefined) return d
  const o = origins.get(d.file.fileName.replace(/\\/g, '/'))
  if (!o) return d
  const at = o.locate(d.start, d.length ?? 0, d.file.text)
  if (!at) return d
  const file = ts.createSourceFile(o.file, o.text, ts.ScriptTarget.Latest)
  return { ...d, file, start: at[0], length: at[1] }
}

/** The author's `<script>` sits in both an island's virtual TSX and its
 *  compiled client module; once mapped back, one error is reported once. */
function dedupe(diagnostics: ts.Diagnostic[]): ts.Diagnostic[] {
  const seen = new Set<string>()
  return diagnostics.filter((d) => {
    if (!d.file || d.start === undefined) return true
    const key = `${d.file.fileName}:${d.start}:${d.code}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function relPath(root: string, p: string): string {
  return relative(root, p).replace(/\\/g, '/') || '.'
}

/** An island's compiled client module, typechecked as written to
 *  `.stator/check/<rel>.client.check.tsx`: the author's `<script>` plus the
 *  wiring the compiler generates for its template (`on:click={pick}` →
 *  `this.pick(e)`), which the virtual TSX does not model. */
interface CompiledClient {
  file: string
  text: string
  code: string
  map: SourceMapV3
}

/** Compile every `.stator` file, keeping the errors, the warnings, and each
 *  island's client module. Errors and warnings are formatted like tsc's
 *  diagnostics (`file:line:col - error`) with the compiler's own code frame. */
async function compileAll(
  root: string,
  files: string[],
): Promise<{ errors: string[]; warnings: string[]; clients: CompiledClient[] }> {
  const errors: string[] = []
  const warnings: string[] = []
  const clients: CompiledClient[] = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const { id, kind } = sourceId(root, file)
    const rel = relative(root, file).replace(/\\/g, '/')
    for (const w of compileWarnings(source)) {
      warnings.push(
        `${rel}:${w.loc.line}:${w.loc.column} - warning: ${w.message}\n\n${w.loc.frame}`,
      )
    }
    try {
      const r = compile(source, {
        id,
        kind,
        resolveRegions: regionResolverFor(file, source),
        sourceMap: { source: rel },
      })
      if (r.isClient && r.clientMap) {
        clients.push({ file, text: source, code: r.clientCode, map: r.clientMap })
      }
    } catch (e) {
      if (!(e instanceof CompileError)) throw e
      errors.push(
        e.loc
          ? `${rel}:${e.loc.line}:${e.loc.column} - error: ${e.message}\n\n${e.loc.frame}`
          : `${rel} - error: ${e.message}`,
      )
    }
  }
  return { errors, warnings, clients }
}

export async function run(ctx: CliContext): Promise<void> {
  await checkStack(ctx.root, {
    ...(ctx.rest[0] ? { dir: ctx.rest[0] } : {}),
    ...(ctx.routesDir ? { routesDir: ctx.routesDir } : {}),
  })
}
