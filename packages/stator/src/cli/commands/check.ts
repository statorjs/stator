import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import ts from 'typescript'
import { syncTypes } from '../../build/index.ts'
import { sourceId } from '../../build/source-id.ts'
import { CompileError, compile, regionResolverFor } from '../../compiler/index.ts'
import type { CliContext } from '../run.ts'

/**
 * Validate the WHOLE stack — server machines/routes/lib plus the generated
 * `.stator` types — with no output. This is the piece production builds were
 * missing: `buildApp` only ever touched client islands and copied server files
 * to `dist/` unvalidated, so a broken server import shipped silently. `build`
 * now runs this first.
 *
 * Three steps: (1) `syncTypes` regenerates each `.stator.d.ts` + the virtual TSX
 * the language server typechecks, so the app's `tsconfig` sees current types;
 * (2) every `.stator` file goes through the real compiler — the same call `dev`
 * makes on import and the editor makes per edit, so all three reject the same
 * inputs; (3) a `tsc --noEmit`-equivalent pass via the TypeScript API.
 */
export async function checkStack(root: string): Promise<void> {
  const { written, files } = await syncTypes(root)

  const compileErrors = await compileAll(root, files)
  if (compileErrors.length > 0) {
    process.stderr.write(`${compileErrors.join('\n\n')}\n\n`)
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
  const n = compileErrors.length + diagnostics.length
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

  process.stdout.write(
    `stator check: ok — ${written} .stator.d.ts, ${appFiles} app files (${frameworkFiles} framework files)\n`,
  )
}

/** Compile every `.stator` file, keeping only the errors — output is
 *  discarded. Formatted like tsc's diagnostics (`file:line:col - error`) with
 *  the compiler's own code frame. */
async function compileAll(root: string, files: string[]): Promise<string[]> {
  const errors: string[] = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const { id, kind } = sourceId(root, file)
    try {
      compile(source, { id, kind, resolveRegions: regionResolverFor(file, source) })
    } catch (e) {
      if (!(e instanceof CompileError)) throw e
      const rel = relative(root, file).replace(/\\/g, '/')
      errors.push(
        e.loc
          ? `${rel}:${e.loc.line}:${e.loc.column} - error: ${e.message}\n\n${e.loc.frame}`
          : `${rel} - error: ${e.message}`,
      )
    }
  }
  return errors
}

export async function run(ctx: CliContext): Promise<void> {
  await checkStack(ctx.root)
}
