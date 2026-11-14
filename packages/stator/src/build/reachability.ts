import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire, findPackageJSON } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { probeModule, scanImports } from './imports.ts'

/**
 * What a route reaches: the one import-graph walk that route CSS, route
 * islands and the compiled-contract, custom-element and machine checks all read.
 *
 * The walk is a static read of import specifiers, not module evaluation, and
 * "reached" is import reachability, not render tracing: a component used only
 * in an inactive `match`/`when`/`each` arm is reached, since a live update can
 * activate that arm with no fresh request.
 *
 * Imports are read by `imports.ts`, so one in a comment or a string is not
 * one. Relative imports are followed inside the app root, an extensionless one
 * probed as `.ts`, `.js`, `/index.ts`, `/index.js`. A bare specifier is
 * resolved as an ES module import from the importing file (`resolveBare`), and the package it
 * lands in is walked through its own relative imports, inside that package's
 * root, and on through its own bare imports, to any depth. Only Stator-aware
 * packages are entered (`@statorjs/stator` itself, or one depending on it):
 * nothing else can hold a component, and walking all of TipTap or Hono would
 * cost a dependency tree's worth of reads for nothing. So a library rendering
 * `<Image>` brings `<Image>`'s CSS with it, and a library composing another
 * library's island brings the island (`library-islands.ts` checks that the app
 * registers the machines it dispatches to).
 */

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
    code = await readFile(file, 'utf8')
  } catch {
    return { relative: [], bare: [] }
  }
  const imports: Imports = { relative: [], bare: [] }
  for (const { spec } of scanImports(code, file)) {
    if (spec.startsWith('.')) {
      const base = resolve(file, '..', spec)
      imports.relative.push(probeModule(base) ?? base)
    } else if (!spec.startsWith('node:')) imports.bare.push(spec)
  }
  parsed.set(file, { mtimeMs: stat.mtimeMs, imports })
  return imports
}

const within = (dir: string, file: string): boolean => file === dir || file.startsWith(dir + sep)

/**
 * Where `spec`, imported from `importer`, resolves for an ES module import, or
 * undefined when it does not resolve (a type-only package, a typo). A package
 * with an `exports` map is resolved through it under the `import`, `node` and
 * `default` conditions; anything else, or an `exports` map with no match, goes
 * through Node's `require` resolution. Either way the result is a real path.
 */
export function resolveBare(spec: string, importer: string): string | undefined {
  const viaExports = resolveExports(spec, importer)
  if (viaExports) return viaExports
  try {
    return createRequire(importer).resolve(spec)
  } catch {
    return undefined
  }
}

const IMPORT_CONDITIONS = new Set(['import', 'node', 'default'])

function resolveExports(spec: string, importer: string): string | undefined {
  let pkgJson: string | undefined
  try {
    pkgJson = findPackageJSON(spec, pathToFileURL(importer))
  } catch {
    return undefined
  }
  if (!pkgJson) return undefined
  let json: { name?: string; exports?: unknown }
  try {
    json = JSON.parse(readFileSync(pkgJson, 'utf8')) as typeof json
  } catch {
    return undefined
  }
  if (json.exports === undefined || json.exports === null) return undefined
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!
  const subpath = `.${spec.slice(name.length)}`
  const hit = exportsTarget(json.exports, subpath)
  if (!hit?.startsWith('./')) return undefined
  // The real path, as `require.resolve` and the bundler both report it. A
  // package manager that links packages in (pnpm) makes the path under
  // `node_modules/<name>` a symlink, and a module named by it would not match
  // the same module named by anything else.
  let root: string
  let file: string
  try {
    root = realpathSync(dirname(pkgJson))
    file = realpathSync(resolve(root, hit))
  } catch {
    return undefined
  }
  return within(root, file) ? file : undefined
}

/** The target `exports` maps `subpath` to, `*` patterns substituted. */
function exportsTarget(exports: unknown, subpath: string): string | undefined {
  const isMap =
    typeof exports === 'object' &&
    exports !== null &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((k) => k.startsWith('.'))
  if (!isMap) return subpath === '.' ? conditionTarget(exports, undefined) : undefined
  const map = exports as Record<string, unknown>
  if (subpath in map && !subpath.includes('*')) return conditionTarget(map[subpath], undefined)
  let best: { key: string; star: string } | undefined
  for (const key of Object.keys(map)) {
    const i = key.indexOf('*')
    if (i === -1) continue
    const [pre, post] = [key.slice(0, i), key.slice(i + 1)]
    if (!subpath.startsWith(pre) || !subpath.endsWith(post) || subpath.length < key.length - 1)
      continue
    if (!best || pre.length > best.key.indexOf('*')) {
      best = { key, star: subpath.slice(pre.length, subpath.length - post.length) }
    }
  }
  return best ? conditionTarget(map[best.key], best.star) : undefined
}

function conditionTarget(target: unknown, star: string | undefined): string | undefined {
  if (typeof target === 'string') return star === undefined ? target : target.replaceAll('*', star)
  if (Array.isArray(target)) {
    for (const t of target) {
      const hit = conditionTarget(t, star)
      if (hit) return hit
    }
    return undefined
  }
  if (typeof target === 'object' && target !== null) {
    for (const [cond, value] of Object.entries(target)) {
      if (!IMPORT_CONDITIONS.has(cond)) continue
      const hit = conditionTarget(value, star)
      if (hit) return hit
    }
  }
  return undefined
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
