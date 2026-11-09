import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compileComponentFile } from './compile-component.ts'
import { walkFiles } from './islands.ts'
import { assertBrowserSafe, stubMachineImports } from './lib-client.ts'
import { entryCss } from './route-css.ts'

export interface CompileLibraryOptions {
  /** Package root. Compiled ids (scope hashes, diagnostics) are relative to
   *  it, qualified by the package name read from its `package.json` — two
   *  libraries with the same file layout must not share a scope. */
  root: string
  /** Directory holding the `.stator` sources; walked recursively. */
  dir: string
  /** The barrel the published stylesheet is aggregated for. Defaults to
   *  `<dir>/index.ts` when it exists; with no barrel every component's CSS is
   *  included. */
  entry?: string
  /** Where the aggregated stylesheet is written. Default `<dir>/components.css`. */
  cssOut?: string
}

export interface CompileLibraryResult {
  compiled: number
  islands: number
  /** The server machines the library's islands dispatch to (their stubs'
   *  names). A consuming app registers these. */
  machines: string[]
  cssOut: string
  cssBytes: number
  /** The barrel the stylesheet was aggregated from; undefined when every
   *  component's CSS was included. */
  entry?: string
  /** The package name the compiled ids were qualified with; undefined when
   *  the root has no named `package.json` (ids are then path-relative, and
   *  the CLI says so). */
  packageName?: string
}

/**
 * Compile a component library for publishing. Every `.stator` under `dir`
 * becomes its sibling `.stator.ts` (+ `.css` when styled), `.stator` imports
 * between them are rewritten to the compiled siblings, and one stylesheet is
 * aggregated for the package's `./components.css` export — the same walk a
 * route's CSS uses, rooted at the barrel, so the published file holds exactly
 * what the barrel reaches.
 */
export async function compileLibrary(opts: CompileLibraryOptions): Promise<CompileLibraryResult> {
  const root = resolve(opts.root)
  const dir = resolve(opts.dir)
  const files = (
    await walkFiles(
      dir,
      (f) => f.endsWith('.stator'),
      (name) => name === 'node_modules' || name === 'dist' || name.startsWith('.'),
    )
  ).sort()

  const packageName = await readPackageName(root)
  let islands = 0
  const compiled: string[] = []
  const clientFiles: string[] = []
  for (const file of files) {
    const r = await compileComponentFile(file, root, packageName ? { idPrefix: packageName } : {})
    if (r.isClient) islands++
    compiled.push(`${file}.ts`)
    if (r.clientFile) {
      compiled.push(r.clientFile)
      clientFiles.push(r.clientFile)
    }
  }

  // A component importing a sibling `.stator` must import the compiled module
  // in the published package. Bare specifiers stay as written: a package's
  // exports map resolves them.
  for (const file of compiled) {
    const code = await readFile(file, 'utf8')
    const rewritten = code.replace(/(['"])(\.\.?\/[^'"]+\.stator)\1/g, '$1$2.ts$1')
    if (rewritten !== code) await writeFile(file, rewritten)
  }

  // A published client entry carries no server code: machine imports become
  // `{ name }` stubs, then a browser bundle of each entry proves nothing on the
  // server side is left.
  const machines = new Set<string>()
  for (const file of clientFiles) {
    for (const name of await stubMachineImports(file)) machines.add(name)
    await assertBrowserSafe(file, root)
  }

  const entry = opts.entry ? resolve(opts.entry) : await existing(join(dir, 'index.ts'))
  const cssOut = opts.cssOut ? resolve(opts.cssOut) : join(dir, 'components.css')
  let css = ''
  if (entry) {
    css = await entryCss(entry, root)
  } else {
    for (const file of files) {
      const text = await readFile(`${file}.css`, 'utf8').catch(() => undefined)
      if (text) css += `/* ${file.slice(root.length + 1).replace(/\\/g, '/')}.ts */\n${text}\n`
    }
  }
  // Always written, even empty, so the `./components.css` export resolves.
  await writeFile(cssOut, css)

  return {
    compiled: files.length,
    islands,
    machines: [...machines].sort(),
    cssOut,
    cssBytes: css.length,
    entry,
    ...(packageName ? { packageName } : {}),
  }
}

/** The `name` of the package at `root`, or undefined when there is no
 *  readable, named `package.json` there. */
async function readPackageName(root: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      name?: unknown
    }
    return typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : undefined
  } catch {
    return undefined
  }
}

async function existing(path: string): Promise<string | undefined> {
  try {
    await stat(path)
    return path
  } catch {
    return undefined
  }
}
