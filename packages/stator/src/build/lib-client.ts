import { readFile, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { probeModule, scanImports } from './imports.ts'
import { isServerMachineModule, machineName } from './machines.ts'

/**
 * The publish-time half of library islands: a published client entry must reach only browser-safe code on
 * its own, so a consuming app's bundler needs to know nothing about the
 * package's machines.
 */

/** Marks a stub in a published client entry, so a consuming build can list
 *  the machines a package island dispatches to (`library-islands.ts`). */
export const MACHINE_STUB = '/* @stator machine */'

/**
 * Replace each default import of a server machine in a compiled client entry
 * with an inline `{ name }` stub, the identity an island dispatches by. The
 * stub takes exactly the import statement's text range, with the statement's
 * newlines kept after it, so every other line stays where it was and the
 * entry's inline source map stays valid. Returns the stubbed machine names.
 */
export async function stubMachineImports(file: string): Promise<string[]> {
  const code = await readFile(file, 'utf8')
  const repls: Array<{ start: number; end: number; text: string }> = []
  const names: string[] = []
  for (const imp of scanImports(code, file)) {
    if (imp.kind !== 'import' || imp.typeOnly || !imp.defaultName) continue
    if (imp.named.length > 0 || imp.namespace || !imp.spec.startsWith('.')) continue
    const target = probeModule(resolve(dirname(file), imp.spec))
    if (!target || !isServerMachineModule(target)) continue
    const name = await machineName(
      target,
      `stator build:lib: cannot stub the machine import "${imp.spec}" in ${file}`,
    )
    const whole = code.slice(imp.start, imp.end)
    const newlines = '\n'.repeat(whole.split('\n').length - 1)
    repls.push({
      start: imp.start,
      end: imp.end,
      text: `const ${imp.defaultName} = ${MACHINE_STUB} { name: ${JSON.stringify(name)} };${newlines}`,
    })
    names.push(name)
  }
  if (repls.length === 0) return names
  let out = code
  for (const r of repls.reverse()) out = out.slice(0, r.start) + r.text + out.slice(r.end)
  await writeFile(file, out)
  return names
}

/** Imports that must never reach a browser bundle: Node built-ins and the
 *  server-side Stator subpaths. */
const SERVER_STATOR = [
  '@statorjs/stator',
  '@statorjs/stator/server',
  '@statorjs/stator/server/runtime',
  '@statorjs/stator/machine',
  '@statorjs/stator/dev',
  '@statorjs/stator/build',
  '@statorjs/stator/register',
  '@statorjs/stator/test-env',
  '@statorjs/stator/config',
  '@statorjs/stator/compiler',
]
const BUILTINS = new Set(builtinModules)
function serverOnly(spec: string): boolean {
  return (
    spec.startsWith('node:') ||
    BUILTINS.has(spec) ||
    BUILTINS.has(spec.split('/')[0]!) ||
    SERVER_STATOR.includes(spec)
  )
}

/**
 * Bundle a client entry for the browser, leaving every bare specifier
 * external, and fail when anything it reaches imports server code: a Node
 * built-in or a server-side Stator subpath. A machine import that survived the
 * stub (a named import, say) shows up here as its `@statorjs/stator/server`
 * import.
 */
export async function assertBrowserSafe(file: string, root: string): Promise<void> {
  const { build } = await import('esbuild')
  let metafile: import('esbuild').Metafile
  try {
    const result = await build({
      entryPoints: [file],
      absWorkingDir: root,
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      metafile: true,
      logLevel: 'silent',
      plugins: [
        {
          name: 'stator-externals',
          setup(b) {
            b.onResolve({ filter: /^[^./]/ }, (args) => ({ path: args.path, external: true }))
          },
        },
      ],
    })
    metafile = result.metafile
  } catch (err) {
    throw new Error(
      `stator build:lib: the browser-safety check could not bundle ${relative(root, file)}: ` +
        (err as Error).message,
    )
  }
  const problems: string[] = []
  for (const [input, info] of Object.entries(metafile.inputs)) {
    for (const imp of info.imports) {
      if (imp.external && serverOnly(imp.path)) {
        problems.push(`${input} imports "${imp.original ?? imp.path}"`)
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `stator build:lib: ${relative(root, file)} would ship server code to the browser:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\nAn island reaches a server machine only through a default import, which build:lib ' +
        'replaces with its { name }; anything else on the server side stays out of the script.',
    )
  }
}
