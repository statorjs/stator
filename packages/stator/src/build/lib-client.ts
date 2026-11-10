import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { probeModule, scanImports } from './imports.ts'
import { assertRunsInBrowser, isMachineModule, machineImportUse, machineName } from './machines.ts'

/**
 * The publish-time half of library islands: a published client entry must reach only browser-safe code on
 * its own, so a consuming app's bundler needs to know nothing about the
 * package's machines.
 */

/** Marks a stub in a published client entry, so a consuming build can list
 *  the machines a package island dispatches to (`library-islands.ts`). */
export const MACHINE_STUB = '/* @stator machine */'

/**
 * Replace each default import of a machine the entry only addresses with an
 * inline `{ name }` stub, the identity an island dispatches by. An import the
 * entry needs the module for (it passes it to `use()`, calls it, takes a named
 * export) is left alone and bundled by the consuming app. The stub takes
 * exactly the import statement's text range, with the statement's newlines
 * kept after it, so every other line stays where it was and the entry's inline
 * source map stays valid; type-only named imports in the statement are kept as
 * an `import type`. Returns the stubbed machine names.
 */
export async function stubMachineImports(file: string): Promise<string[]> {
  const code = await readFile(file, 'utf8')
  const repls: Array<{ start: number; end: number; text: string }> = []
  const names: string[] = []
  for (const imp of scanImports(code, file)) {
    if (imp.kind !== 'import' || imp.typeOnly || !imp.spec.startsWith('.')) continue
    const target = probeModule(resolve(dirname(file), imp.spec))
    if (!target || !isMachineModule(target)) continue
    const use = machineImportUse(file, imp.spec)
    if (use?.kind === 'error') throw new Error(`stator build:lib: ${use.message}`)
    if (use?.kind === 'real') {
      await assertRunsInBrowser(target, file, use.runs)
      continue
    }
    if (!imp.defaultName) continue
    const name = await machineName(
      target,
      `stator build:lib: cannot stub the machine import "${imp.spec}" in ${file}`,
    )
    const whole = code.slice(imp.start, imp.end)
    const newlines = '\n'.repeat(whole.split('\n').length - 1)
    const types = imp.named.map((n) =>
      n.imported === n.local ? n.local : `${n.imported} as ${n.local}`,
    )
    const typeImport =
      types.length > 0
        ? ` import type { ${types.join(', ')} } from ${JSON.stringify(imp.spec)};`
        : ''
    repls.push({
      start: imp.start,
      end: imp.end,
      text: `const ${imp.defaultName} = ${MACHINE_STUB} { name: ${JSON.stringify(name)} };${typeImport}${newlines}`,
    })
    names.push(name)
  }
  if (repls.length === 0) return names
  let out = code
  for (const r of repls.reverse()) out = out.slice(0, r.start) + r.text + out.slice(r.end)
  await writeFile(file, out)
  return names
}

/** Subpaths of `@statorjs/stator` a browser bundle may import: the client
 *  runtime compiled entries import, the engine a machine is defined with, the
 *  template helpers, and the type-only editor contract. Every other code
 *  subpath in its `exports` is server-side. */
const BROWSER_SAFE = new Set(['./client', './machine', './template', './editor'])

/** The server-side `@statorjs/stator` specifiers, from its own `package.json`. */
export const SERVER_STATOR: readonly string[] = (() => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    name: string
    exports: Record<string, unknown>
  }
  return Object.keys(pkg.exports)
    .filter((sub) => !BROWSER_SAFE.has(sub) && !/\.css$/.test(sub))
    .map((sub) => (sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`))
})()
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
 * built-in or a server-side Stator subpath.
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
      if (!imp.external || !serverOnly(imp.path)) continue
      problems.push(`${input} imports "${imp.original ?? imp.path}"`)
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `stator build:lib: ${relative(root, file)} would ship server code to the browser:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\nAn island addresses a server machine through a default import, which build:lib ' +
        'replaces with its { name }, and runs a machine by passing the import to use(). A ' +
        'machine is defined with defineMachine from "@statorjs/stator/machine".',
    )
  }
}
