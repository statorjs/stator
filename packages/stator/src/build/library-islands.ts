import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { COMPILED_CONTRACT, readContract } from '../compiler/contract.ts'
import { statorVersion } from '../version.ts'
import { parseModule } from './imports.ts'
import { walkFiles } from './islands.ts'
import { MACHINE_STUB } from './lib-client.ts'
import { isIslandShell, moduleLabel, type ReachedModule, reachFrom } from './reachability.ts'

/**
 * Islands a consuming app reaches inside packages, and the three checks that
 * make shipping them safe:
 *
 *   - the compiled-shape contract stamp on every reached package component
 *     (a mismatch, or no stamp, refuses the build, naming the package);
 *   - one custom-element tag per source across every island the app bundles;
 *   - every machine a package island dispatches to is registered by the app.
 *
 * A package island is a reached `x.stator.ts` with an `x.stator.client.ts`
 * beside it. Its identity (manifest key, bundle entry name) is its package
 * name plus its path inside the package, `@acme/blocks/src/x.stator`: unique by
 * construction, and the same however many specifiers reach it.
 */

export interface PackageIsland {
  /** `@acme/blocks/src/x.stator`. */
  rel: string
  /** The compiled shell, `…/x.stator.ts`. */
  shell: string
  /** The published client entry, `…/x.stator.client.ts`. */
  entry: string
  /** The package's name. */
  pkg: string
}

export interface IslandReach {
  /** Absolute route file → sorted island rels (app and package), only for
   *  routes reaching at least one island. */
  routes: Map<string, string[]>
  /** Every package island any route reaches, by rel. */
  packageIslands: Map<string, PackageIsland>
  /** Every reached compiled package component (shells and server
   *  components), and every package module named like compiled output in a
   *  shape `build:lib` never emits, by file: what the contract check reads. */
  packageComponents: Map<string, ReachedModule>
}

/**
 * Walk each route and sort what it reaches: app islands by `shells` (the
 * island's server-side module → its rel), package islands by the sibling
 * rule. `@statorjs/stator`'s own components are compiled by the compiler
 * reading them, so they are never contract-checked.
 */
export async function reachIslands(opts: {
  routesDir: string
  baseDir: string
  shells: Map<string, string>
}): Promise<IslandReach> {
  const baseDir = resolve(opts.baseDir)
  const routes = new Map<string, string[]>()
  const packageIslands = new Map<string, PackageIsland>()
  const packageComponents = new Map<string, ReachedModule>()
  const routeFiles = await walkFiles(opts.routesDir, (f) => /\.(ts|js|stator)$/.test(f)).catch(
    () => [] as string[],
  )
  for (const routeFile of routeFiles) {
    const reached = new Set<string>()
    const { modules } = await reachFrom(routeFile, { appRoot: baseDir })
    for (const mod of modules.values()) {
      const app = opts.shells.get(mod.file)
      if (app) {
        reached.add(app)
        continue
      }
      if (!mod.pkg) continue
      const own = mod.pkg.name === '@statorjs/stator'
      if (!own && unrecognisedStator(mod.file)) {
        packageComponents.set(mod.file, mod)
        continue
      }
      if (!mod.file.endsWith('.stator.ts')) continue
      if (!own) packageComponents.set(mod.file, mod)
      if (!isIslandShell(mod.file)) continue
      const rel = moduleLabel(mod, baseDir)
      reached.add(rel)
      packageIslands.set(rel, {
        rel,
        shell: mod.file,
        entry: mod.file.replace(/\.ts$/, '.client.ts'),
        pkg: mod.pkg.name,
      })
    }
    if (reached.size > 0) routes.set(routeFile, [...reached].sort())
  }
  return { routes, packageIslands, packageComponents }
}

/** A module named like compiled Stator output (`x.stator.<ext>`) in a shape
 *  `build:lib` never emits: anything but `x.stator.ts`, `x.stator.client.ts`
 *  and `x.stator.d.ts`. */
export const unrecognisedStator = (file: string): boolean =>
  /\.stator\.[^\\/]+$/.test(file) && !/\.stator\.(client\.ts|ts|d\.ts)$/.test(file)

/**
 * The contract check: every reached package component, and the client entry
 * beside an island shell, must carry this compiler's `COMPILED_CONTRACT`, and
 * a module named like compiled output must be in a shape this compiler emits.
 * Returns one located message per refused file; empty when all match.
 */
export async function contractErrors(components: Iterable<ReachedModule>): Promise<string[]> {
  const errors: string[] = []
  const mine = `Stator ${statorVersion()} reads contract ${COMPILED_CONTRACT}`
  for (const mod of components) {
    const pkg = mod.pkg!
    if (unrecognisedStator(mod.file)) {
      const where = `${pkg.name}/${relative(pkg.root, mod.file).replace(/\\/g, '/')}`
      errors.push(
        `stator: ${where} is named like a compiled Stator component, but \`stator build:lib\` ` +
          'compiles a component to x.stator.ts (with x.stator.client.ts beside an island), so this ' +
          `Stator does not read it. Install a version of ${pkg.name} built with \`stator build:lib\`, ` +
          'or ask its author to republish it.',
      )
      continue
    }
    const client = mod.file.replace(/\.ts$/, '.client.ts')
    for (const file of existsSync(client) ? [mod.file, client] : [mod.file]) {
      const stamp = readContract(await readFile(file, 'utf8'))
      if (stamp?.contract === COMPILED_CONTRACT) continue
      const where = `${pkg.name}/${relative(pkg.root, file).replace(/\\/g, '/')}`
      errors.push(
        stamp
          ? `stator: ${where} was compiled for contract ${stamp.contract} (by Stator ${stamp.compiler ?? 'unknown'}), and ${mine}. ` +
              `Install a version of ${pkg.name} built for this Stator, or ask its author to republish it.`
          : `stator: ${where} carries no compiled-shape stamp, so it was compiled before Stator 3.0, and ${mine}. ` +
              `Install a version of ${pkg.name} built with \`stator build:lib\` from Stator 3.0 or later.`,
      )
    }
  }
  return errors
}

/** The custom-element tags a compiled client entry registers: the string
 *  second argument of each `defineElement(…)` call. */
export function entryTags(code: string): string[] {
  const sf = parseModule(code, 'entry.ts')
  const tags: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'defineElement'
    ) {
      const tag = node.arguments[1]
      if (tag && ts.isStringLiteralLike(tag)) tags.push(tag.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return tags
}

/** The machines a published client entry dispatches to, by its stubs: each
 *  object literal whose only leading trivia is the `MACHINE_STUB` comment, read
 *  for its `name`. */
export function entryMachines(code: string): string[] {
  const sf = parseModule(code, 'entry.ts')
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && isStub(sf, node)) {
      for (const prop of node.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === 'name' &&
          ts.isStringLiteralLike(prop.initializer)
        ) {
          names.add(prop.initializer.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...names]
}

const isStub = (sf: ts.SourceFile, node: ts.Node): boolean =>
  sf.text.slice(node.pos, node.getStart(sf)).trim() === MACHINE_STUB

export interface TaggedIsland {
  rel: string
  tag: string
  /** Where the island's source lives, as the message names it. */
  source: string
}

/**
 * Tags defined by more than one island. The first island to claim a tag
 * keeps it (callers list app islands first, then packages by rel), so dev
 * can keep serving it; every later one is returned with the holder.
 */
export function tagCollisions(
  islands: TaggedIsland[],
): Array<{ tag: string; holder: TaggedIsland; other: TaggedIsland }> {
  const held = new Map<string, TaggedIsland>()
  const out: Array<{ tag: string; holder: TaggedIsland; other: TaggedIsland }> = []
  for (const island of islands) {
    const holder = held.get(island.tag)
    if (!holder) held.set(island.tag, island)
    else if (holder.source !== island.source) out.push({ tag: island.tag, holder, other: island })
  }
  return out
}

export const collisionMessage = (c: {
  tag: string
  holder: TaggedIsland
  other: TaggedIsland
}): string =>
  `stator: <${c.tag}> is defined by both ${c.holder.source} and ${c.other.source}. ` +
  `A page reaching both would fail to upgrade the second; give one of them a different tag ` +
  `(a library's tags should carry a package prefix).`

/**
 * Machines package islands dispatch to that the app does not register.
 * `registered` is the app's machine names.
 */
export async function missingMachines(
  islands: Iterable<PackageIsland>,
  registered: Set<string>,
): Promise<string[]> {
  const errors: string[] = []
  for (const island of islands) {
    for (const name of entryMachines(await readFile(island.entry, 'utf8'))) {
      if (registered.has(name)) continue
      errors.push(
        `stator: the island ${island.rel} dispatches to the machine "${name}", which the app ` +
          `does not register. Re-export it from the app's machines/ (${island.pkg} documents the ` +
          `machines its islands need).`,
      )
    }
  }
  return errors
}

/** The machine names a package island set needs, without reading defs: lets a
 *  build skip importing the app's machines when no package island dispatches. */
export async function neededMachines(islands: Iterable<PackageIsland>): Promise<Set<string>> {
  const out = new Set<string>()
  for (const island of islands) {
    for (const name of entryMachines(await readFile(island.entry, 'utf8'))) out.add(name)
  }
  return out
}
