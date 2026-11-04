import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { build, version as esbuildVersion } from 'esbuild'
import type { AnyMachineDef } from '../engine/index.ts'

/**
 * The per-machine code hash — the fingerprint behind "sessions never outlive
 * the code that made them" (spec `machine-state-is-working-state-snapshot-
 * hydration-policy`; follow-ups in `snapshot-policy-follow-ups-…`).
 *
 * Each machine file is bundled by esbuild — tree-shaken, minified, in memory —
 * and the bundle is hashed. The hash therefore changes exactly when code that
 * can execute as part of the machine changes: a guard, action, effect,
 * selector, state, event key or context default, in the machine file or in any
 * module it reaches. Comments, whitespace and exports the machine never uses
 * don't move it. The bundle is a MEASUREMENT, never written or run: what runs
 * stays plain modules with shared instances.
 *
 * Bare specifiers are resolved first and then sorted by where they land:
 *  - the framework (`@statorjs/stator`) and Node builtins — external; the
 *    framework's version is a separate hash input, builtins are the runtime's;
 *  - a package under `node_modules` — external, never bundled (native addons
 *    can't be), but its `name@version` IS a hash input for every machine whose
 *    graph reaches it. A machine that re-exports a chart from a package
 *    (`export * from '@indiepub/stator/machines/owner'`) bundles to a one-line
 *    re-export, so without this a package bump that rewrote the chart's guards
 *    would never reset its sessions — the false negative the policy forbids.
 *    The package boundary is the version: a package's own dependency bumps
 *    don't show, which its version is expected to carry;
 *  - anything else — a tsconfig `paths` alias into app code, a workspace-linked
 *    package — is bundled and content-hashed like a relative import;
 *  - unresolvable — external with no version entry, so the hash never fails a
 *    build the loader wouldn't fail too.
 *  - `.stator` files are external (a machine has no business importing one).
 *
 * Sibling machines are NOT external: a machine that imports another often
 * takes values from it (`weather.ts` mirrors `DEFAULT_CLOCK` from
 * `settings.ts` into its own context), and a default changed in the sibling
 * must reset the importer too. The cost is over-reset — a machine imported only
 * for identity (`subscribes: [{ from: Sibling }]`) still resets its importers
 * when it changes — which the principle permits; a missed reset it does not.
 *
 * One esbuild invocation hashes every machine, so build-time cost does not
 * scale with the number of calls; `stator build` fails on a machine whose
 * closure cannot be bundled (an import problem that belongs in CI, not at a
 * production boot).
 */

export interface MachineHash {
  hash: string
  /** Absolute paths of every source module bundled into this machine. */
  inputs: string[]
  /** `name@version` of every package the machine's graph reaches (sorted,
   *  framework and builtins excluded). Each is a hash input. */
  packages: string[]
}

export interface HashMachinesOptions {
  /** The conventional machines directory. Kept for the stable ids of
   *  externalized `.stator` imports; siblings are bundled, not external. */
  machinesDir: string
}

const FRAMEWORK = '@statorjs/stator'

const statorVersion: string = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version

const OUTDIR = '/__stator_machine_hash__'

/** Marker on our own `build.resolve` calls so the plugin lets esbuild answer
 *  them instead of re-entering itself. */
const OWN_RESOLVE = { statorMachineHash: true }

/** Hash every machine file in one esbuild pass. Throws if any closure cannot
 *  be bundled — the error names the machine. */
export async function hashMachines(
  files: readonly string[],
  opts: HashMachinesOptions,
): Promise<Map<string, MachineHash>> {
  const out = new Map<string, MachineHash>()
  if (files.length === 0) return out
  // esbuild reports real paths (macOS: /var → /private/var); key everything by
  // realpath and hand results back under the caller's own spelling.
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const machinesDir = real(opts.machinesDir)
  const wanted = new Map(files.map((f) => [real(f), f]))
  const cwd = process.cwd()
  // Every external package import seen during the build, keyed by
  // importer + specifier (the same specifier can resolve to different versions
  // from different directories): its `name@version`, or null when unversioned.
  const packageIds = new Map<string, string | null>()
  const packageIdCache = new Map<string, string | null>()

  const result = await build({
    entryPoints: [...wanted.keys()],
    absWorkingDir: cwd,
    bundle: true,
    // Strip whitespace and fold syntax, but do NOT rename identifiers: esbuild
    // allocates minified names across the whole module set, so a dead export
    // in an imported module can shift the names in the bundle — and the hash
    // would move for code that never runs. Keeping source identifiers makes the
    // output a function of the reachable code only.
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outdir: OUTDIR,
    entryNames: '[dir]/[name]',
    legalComments: 'none',
    sourcemap: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'stator-machine-hash-externals',
        setup(b) {
          b.onResolve({ filter: /.*/ }, async (args) => {
            if (args.kind === 'entry-point') return null
            if (args.pluginData === OWN_RESOLVE) return null
            if (!args.path.startsWith('.') && !isAbsolute(args.path)) {
              // Bare specifier. The framework and builtins are external
              // outright; everything else is resolved before it is judged.
              if (isBuiltin(args.path) || packageNameOf(args.path) === FRAMEWORK) {
                return { path: args.path, external: true }
              }
              const r = await b.resolve(args.path, {
                kind: args.kind,
                importer: args.importer,
                resolveDir: args.resolveDir,
                pluginData: OWN_RESOLVE,
              })
              if (r.errors.length > 0 || r.external || !r.path) {
                return { path: args.path, external: true }
              }
              const resolved = real(r.path)
              if (!/[\\/]node_modules[\\/]/.test(resolved)) {
                // App code behind an alias, or a workspace link: part of the
                // closure, hashed by content.
                return { path: resolved }
              }
              packageIds.set(
                externalKey(real(args.importer), args.path),
                packageIdAbove(resolved, packageIdCache),
              )
              return { path: args.path, external: true }
            }
            const abs = real(resolve(args.resolveDir, args.path))
            // Externals keep their specifier in the bundle, so give a template a
            // STABLE id (relative to machinesDir), never an absolute path — or the
            // hash would change with the checkout directory.
            if (abs.endsWith('.stator')) {
              return {
                path: `stator:${relative(machinesDir, abs).replace(/\\/g, '/')}`,
                external: true,
              }
            }
            return null
          })
        },
      },
    ],
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`stator: cannot hash machine closure — ${msg}`)
  })

  // Map each output bundle back to its entry via the metafile.
  for (const file of result.outputFiles) {
    const key = relative(cwd, file.path).replace(/\\/g, '/')
    const meta = result.metafile.outputs[key]
    if (!meta?.entryPoint) continue
    const entry = wanted.get(real(resolve(cwd, meta.entryPoint)))
    if (entry === undefined) continue
    // The closure comes from the resolved import GRAPH (`metafile.inputs`),
    // not from `outputs[*].inputs` — that lists only modules that contributed
    // bytes, and a module whose only used export is a constant the minifier
    // inlined contributes none while still being code the machine depends on.
    const graph = walkGraph(meta.entryPoint, result.metafile.inputs, cwd, real)
    const packages = [
      ...new Set(
        graph.externals
          .map((e) => packageIds.get(externalKey(e.importer, e.path)))
          .filter((id): id is string => typeof id === 'string'),
      ),
    ].sort()
    const digest = createHash('sha256')
      .update(file.contents)
      .update('\0')
      .update(statorVersion)
      .update('\0')
      .update(esbuildVersion)
    // Appended only when there is something to append, so a machine that
    // reaches no package keeps the digest it had before packages counted.
    if (packages.length > 0) digest.update('\0').update(packages.join('\n'))
    out.set(entry, { hash: digest.digest('hex'), inputs: graph.inputs, packages })
  }
  for (const f of files) {
    if (!out.has(f)) throw new Error(`stator: no bundle produced for machine ${f}`)
  }
  return out
}

function externalKey(importer: string, specifier: string): string {
  return `${importer}\0${specifier}`
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/** `name@version` from the nearest named `package.json` above a resolved
 *  module file, or null. pnpm's real paths sit under
 *  `.pnpm/<name>@<version>…/node_modules/<name>/`, so the first named manifest
 *  up the tree is the package's own, never the app's. */
function packageIdAbove(file: string, cache: Map<string, string | null>): string | null {
  let dir = dirname(file)
  const visited: string[] = []
  let found: string | null = null
  while (true) {
    const hit = cache.get(dir)
    if (hit !== undefined) {
      found = hit
      break
    }
    visited.push(dir)
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: unknown
          version?: unknown
        }
        if (typeof pkg.name === 'string' && pkg.name !== '') {
          found = `${pkg.name}@${typeof pkg.version === 'string' ? pkg.version : '0'}`
          break
        }
      } catch {
        // An unreadable manifest is not this package's; keep walking.
      }
    }
    const parent = dirname(dir)
    if (parent === dir || !/[\\/]node_modules[\\/]/.test(`${parent}/`)) {
      // Left the node_modules tree without a named manifest.
      break
    }
    dir = parent
  }
  for (const d of visited) cache.set(d, found)
  return found
}

interface Graph {
  inputs: string[]
  externals: Array<{ importer: string; path: string }>
}

function walkGraph(
  entryKey: string,
  inputs: Record<string, { imports: Array<{ path: string; external?: boolean }> }>,
  cwd: string,
  real: (p: string) => string,
): Graph {
  const seen = new Set<string>()
  const externals: Graph['externals'] = []
  const stack = [entryKey]
  while (stack.length) {
    const key = stack.pop()!
    if (seen.has(key)) continue
    seen.add(key)
    for (const imp of inputs[key]?.imports ?? []) {
      if (imp.external) externals.push({ importer: real(resolve(cwd, key)), path: imp.path })
      else stack.push(imp.path)
    }
  }
  return { inputs: [...seen].map((k) => resolve(cwd, k)), externals }
}

// ── Def registry ─────────────────────────────────────────────────────────────
// Discovery attaches each def's hash here; hydration reads it. A WeakMap keyed
// by the def object keeps the def type untouched and needs no plumbing —
// whoever has the def has the hash.
const hashes = new WeakMap<AnyMachineDef, { hash: string; inputs: readonly string[] }>()

export function setCodeHash(
  def: AnyMachineDef,
  hash: string,
  inputs: readonly string[] = [],
): void {
  hashes.set(def, { hash, inputs })
}

export function codeHashOf(def: AnyMachineDef): string | undefined {
  return hashes.get(def)?.hash
}

/** Absolute paths of the modules in the def's hashed closure (empty when the
 *  hash came from a manifest). The dev servers use it to decide whether an
 *  edit touches a machine at all. */
export function codeInputsOf(def: AnyMachineDef): readonly string[] {
  return hashes.get(def)?.inputs ?? []
}
