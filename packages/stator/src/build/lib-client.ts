import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The publish-time half of library islands (spec `library-islands-…`,
 * Approach 1): a published client entry must reach only browser-safe code on
 * its own, so a consuming app's bundler needs to know nothing about the
 * package's machines.
 */

/** A module that defines a server machine: it imports `defineMachine`
 *  (from `@statorjs/stator/server`, or inside the framework by path). Read as
 *  text first, so a client helper that touches browser globals is never
 *  imported in Node to find out. */
function isServerMachineModule(file: string): boolean {
  return /import\s*\{[^}]*\bdefineMachine\b[^}]*\}\s*from/.test(readFileSync(file, 'utf8'))
}

const DEFAULT_IMPORT_RE = /import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])(\.{1,2}\/[^'"]+)\2[ \t]*;?/g

/**
 * Replace each default import of a server machine in a compiled client entry
 * with an inline `{ name }` stub, the identity an island dispatches by. The
 * rewrite is line-preserving (the stub takes the import's place, newlines
 * kept), so the entry's inline source map stays valid. Returns the stubbed
 * machine names.
 */
export async function stubMachineImports(file: string): Promise<string[]> {
  const code = await readFile(file, 'utf8')
  const repls: Array<{ start: number; end: number; text: string }> = []
  const names: string[] = []
  for (const m of code.matchAll(DEFAULT_IMPORT_RE)) {
    const [whole, id, , spec] = m as unknown as [string, string, string, string]
    const base = resolve(dirname(file), spec)
    const target = [base, `${base}.ts`, `${base}.js`].find((f) => existsSync(f))
    if (!target || !isServerMachineModule(target)) continue
    let name: unknown
    try {
      const mod = (await import(pathToFileURL(target).href)) as { default?: { name?: unknown } }
      name = mod.default?.name
    } catch (err) {
      throw new Error(
        `stator build:lib: cannot stub the machine import "${spec}" in ${file}: importing it in ` +
          `Node failed: ${(err as Error).message}`,
      )
    }
    if (typeof name !== 'string') {
      throw new Error(
        `stator build:lib: "${spec}" in ${file} imports defineMachine but does not ` +
          `default-export a machine with a name, so it cannot be stubbed for the browser.`,
      )
    }
    const newlines = '\n'.repeat(whole.split('\n').length - 1)
    repls.push({
      start: m.index,
      end: m.index + whole.length,
      text: `const ${id} = { name: ${JSON.stringify(name)} };${newlines}`,
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
