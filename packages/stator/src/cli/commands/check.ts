import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { syncTypes } from '../../build/index.ts'
import { contractErrors, reachIslands } from '../../build/library-islands.ts'
import { sourceId } from '../../build/source-id.ts'
import { CompileError, compile, compileWarnings, regionResolverFor } from '../../compiler/index.ts'
import type { CliContext } from '../run.ts'

/**
 * Validate the WHOLE stack — server machines/routes/lib plus the generated
 * `.stator` types — with no output. `stator build` runs it first, so a broken
 * server import fails the build instead of shipping.
 *
 * Four steps: (1) `syncTypes` regenerates each `.stator.d.ts` + the virtual TSX
 * the language server typechecks, so the app's `tsconfig` sees current types;
 * (2) every `.stator` file goes through the real compiler — the same call `dev`
 * makes on import and the editor makes per edit, so all three reject the same
 * inputs; (3) every compiled component the routes reach in a package carries
 * this compiler's contract stamp (`library-islands.ts`), walking from
 * `opts.routesDir` (default `<root>/routes`); (4) a
 * `tsc --noEmit`-equivalent pass via the TypeScript API.
 * Compiler warnings print alongside the compile step but don't fail the check.
 */
export async function checkStack(root: string, opts: { routesDir?: string } = {}): Promise<void> {
  const { written, files } = await syncTypes(root)

  const { errors: compileErrors, warnings } = await compileAll(root, files)
  if (warnings.length > 0) {
    process.stderr.write(`${warnings.join('\n\n')}\n\n`)
  }
  if (compileErrors.length > 0) {
    process.stderr.write(`${compileErrors.join('\n\n')}\n\n`)
  }

  const reach = await reachIslands({
    routesDir: opts.routesDir ? resolve(root, opts.routesDir) : join(root, 'routes'),
    baseDir: root,
    shells: new Map(),
  })
  const stampErrors = await contractErrors(reach.packageComponents.values())
  if (stampErrors.length > 0) process.stderr.write(`${stampErrors.join('\n\n')}\n\n`)

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
  const diagnostics = [
    ...program.getConfigFileParsingDiagnostics(),
    ...ts.getPreEmitDiagnostics(program),
  ]

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

/** Compile every `.stator` file, keeping only the errors and warnings —
 *  output is discarded. Formatted like tsc's diagnostics (`file:line:col -
 *  error`) with the compiler's own code frame. */
async function compileAll(
  root: string,
  files: string[],
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = []
  const warnings: string[] = []
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
      compile(source, { id, kind, resolveRegions: regionResolverFor(file, source) })
    } catch (e) {
      if (!(e instanceof CompileError)) throw e
      errors.push(
        e.loc
          ? `${rel}:${e.loc.line}:${e.loc.column} - error: ${e.message}\n\n${e.loc.frame}`
          : `${rel} - error: ${e.message}`,
      )
    }
  }
  return { errors, warnings }
}

export async function run(ctx: CliContext): Promise<void> {
  await checkStack(ctx.root)
}
