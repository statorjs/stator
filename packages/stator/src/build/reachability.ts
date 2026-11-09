import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * What a route reaches: the one import-graph walk that route CSS, route
 * islands and the compiled-contract, custom-element and machine checks all read.
 *
 * The walk is a static read of import specifiers, not module evaluation, and
 * "reached" is import reachability, not render tracing: a component used only
 * in an inactive `match`/`when`/`each` arm is reached, since a live update can
 * activate that arm with no fresh request.
 *
 * Relative imports are followed inside the app root. A bare specifier is
 * resolved with Node resolution from the importing file, and the package it
 * lands in is walked through its own relative imports, inside that package's
 * root, and on through its own bare imports, to any depth. Only Stator-aware
 * packages are entered (`@statorjs/stator` itself, or one depending on it):
 * nothing else can hold a component, and walking all of TipTap or Hono would
 * cost a dependency tree's worth of reads for nothing. So a library rendering
 * `<Image>` brings `<Image>`'s CSS with it, and a library composing another
 * library's island brings the island (`library-islands.ts` checks that the app
 * registers the machines it dispatches to).
 */

const IMPORT_SPECIFIER_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
const CODE = /\.(ts|mts|tsx|js|mjs|jsx|stator)$/

export interface PackageRef {
  /** The package's `name`. */
  name: string
  /** The directory holding its `package.json`. */
  root: string
  /** `@statorjs/stator` itself, or a package that depends on it: the only
   *  packages that can hold a component, so the only ones walked. */
  stator: boolean
}

export interface ReachedModule {
  file: string
  /** Set for a module inside a package (reached across a bare specifier). */
  pkg?: PackageRef
}

export interface Reach {
  /** Every reached module, keyed by its path. */
  modules: Map<string, ReachedModule>
}

/** Strip `/* *\/` and `//` comments before scanning for import specifiers,
 *  so a doc-comment usage example isn't mistaken for a real import. Tracks
 *  string/template-literal state so a `//` or `/*` inside one is left alone.
 *  Not a full tokenizer (doesn't walk into `${...}` interpolation); errs
 *  toward under-stripping. */
function stripComments(code: string): string {
  let out = ''
  let i = 0
  let inString: '"' | "'" | '`' | null = null
  while (i < code.length) {
    const c = code[i]!
    const next = code[i + 1]
    if (inString) {
      out += c
      if (c === '\\' && next !== undefined) {
        out += next
        i += 2
        continue
      }
      if (c === inString) inString = null
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c
      out += c
      i += 1
      continue
    }
    if (c === '/' && next === '/') {
      const nl = code.indexOf('\n', i)
      i = nl === -1 ? code.length : nl
      continue
    }
    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end === -1 ? code.length : end + 2
      continue
    }
    out += c
    i += 1
  }
  return out
}

interface Imports {
  relative: string[]
  bare: string[]
}

// Each file's specifiers, kept for the process and re-read when the file's
// mtime moves: a dev rebuild re-walks every route, and most files have not
// changed. `node_modules` is immutable for the process but costs only a stat.
const parsed = new Map<string, { mtimeMs: number; imports: Imports }>()

async function importsOf(file: string): Promise<Imports> {
  const stat = statSync(file, { throwIfNoEntry: false })
  if (!stat) return { relative: [], bare: [] }
  const hit = parsed.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.imports
  let code: string
  try {
    code = stripComments(await readFile(file, 'utf8'))
  } catch {
    return { relative: [], bare: [] }
  }
  const imports: Imports = { relative: [], bare: [] }
  for (const match of code.matchAll(IMPORT_SPECIFIER_RE)) {
    const spec = match[1]!
    if (spec.startsWith('.')) imports.relative.push(resolve(file, '..', spec))
    else if (!spec.startsWith('node:')) imports.bare.push(spec)
  }
  parsed.set(file, { mtimeMs: stat.mtimeMs, imports })
  return imports
}

const within = (dir: string, file: string): boolean => file === dir || file.startsWith(dir + sep)

/** Node's resolution of `spec` from `importer`, or undefined when it does not
 *  resolve (an `import`-only export, a type-only package, a typo). */
function resolveBare(spec: string, importer: string): string | undefined {
  try {
    return createRequire(importer).resolve(spec)
  } catch {
    return undefined
  }
}

const packages = new Map<string, PackageRef | null>()

/** The package a file belongs to: the nearest `package.json` with a name. */
function packageOf(file: string): PackageRef | undefined {
  let dir = dirname(file)
  const seen: string[] = []
  for (;;) {
    const known = packages.get(dir)
    if (known !== undefined) {
      for (const d of seen) packages.set(d, known)
      return known ?? undefined
    }
    seen.push(dir)
    try {
      const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
      }
      const name = json.name
      if (name) {
        const stator =
          name === '@statorjs/stator' ||
          [json.dependencies, json.peerDependencies, json.optionalDependencies].some(
            (deps) => deps?.['@statorjs/stator'] !== undefined,
          )
        const ref = { name, root: dir, stator }
        for (const d of seen) packages.set(d, ref)
        return ref
      }
    } catch {
      // no package.json here
    }
    const parent = dirname(dir)
    if (parent === dir) {
      for (const d of seen) packages.set(d, null)
      return undefined
    }
    dir = parent
  }
}

/** A compiled island shell: `x.stator.ts` with an `x.stator.client.ts` beside it. */
export const isIslandShell = (file: string): boolean =>
  file.endsWith('.stator.ts') && existsSync(file.replace(/\.ts$/, '.client.ts'))

/**
 * Walk from `entry`. `appRoot` bounds the app's relative imports; `packages:
 * false` stops at every bare specifier (a library aggregating its own CSS).
 */
export async function reachFrom(
  entry: string,
  opts: { appRoot: string; packages?: boolean },
): Promise<Reach> {
  const appRoot = resolve(opts.appRoot)
  const modules = new Map<string, ReachedModule>()
  const visit = async (file: string, pkg: PackageRef | undefined): Promise<void> => {
    if (modules.has(file)) return
    modules.set(file, pkg ? { file, pkg } : { file })
    const { relative: rel, bare } = await importsOf(file)
    const bound = pkg ? pkg.root : appRoot
    for (const target of rel) if (within(bound, target)) await visit(target, pkg)
    if (opts.packages === false) return
    for (const spec of bare) {
      const target = resolveBare(spec, file)
      if (!target || !CODE.test(target)) continue
      // A bare specifier from the app that resolves back into the app (a
      // package `imports` alias, a workspace self-reference) is an app module.
      if (!pkg && within(appRoot, target) && !target.includes(`${sep}node_modules${sep}`)) {
        await visit(target, undefined)
        continue
      }
      const ref = packageOf(target)
      if (!ref?.stator) continue
      await visit(target, ref.root === pkg?.root ? pkg : ref)
    }
  }
  await visit(resolve(entry), undefined)
  return { modules }
}

/** How a reached module is named in a stylesheet comment and ordered: an app
 *  module by its path from the app root, a package module by package name plus
 *  its path inside the package, compiled `.stator.ts` named as its `.stator`. */
export function moduleLabel(mod: ReachedModule, appRoot: string): string {
  const rel = mod.pkg
    ? `${mod.pkg.name}/${relative(mod.pkg.root, mod.file)}`
    : relative(resolve(appRoot), mod.file)
  return rel
    .split(sep)
    .join('/')
    .replace(/\.stator\.ts$/, '.stator')
}
