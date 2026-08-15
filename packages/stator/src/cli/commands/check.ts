import ts from 'typescript'
import { syncTypes } from '../../build/index.ts'
import type { CliContext } from '../run.ts'

/**
 * Validate the WHOLE stack — server machines/routes/lib plus the generated
 * `.stator` types — with no output. This is the piece production builds were
 * missing: `buildApp` only ever touched client islands and copied server files
 * to `dist/` unvalidated, so a broken server import shipped silently. `build`
 * now runs this first.
 *
 * Two steps: (1) `syncTypes` regenerates each `.stator.d.ts` + the virtual TSX
 * the language server typechecks, so the app's `tsconfig` sees current types;
 * (2) a `tsc --noEmit`-equivalent pass via the TypeScript API over that config.
 */
export async function checkStack(root: string): Promise<void> {
  const { written } = await syncTypes(root)

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
    const n = diagnostics.length
    throw new Error(`typecheck failed with ${n} error${n === 1 ? '' : 's'}`)
  }

  process.stdout.write(
    `stator check: ok — ${written} .stator.d.ts, ${program.getSourceFiles().length} files typechecked\n`,
  )
}

export async function run(ctx: CliContext): Promise<void> {
  await checkStack(ctx.root)
}
