import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { build, version as esbuildVersion } from 'esbuild'
import type { AnyMachineDef } from '../engine/index.ts'

/**
 * The per-machine code hash — the fingerprint behind "sessions never outlive
 * the code that made them" (spec `machine-state-is-working-state-snapshot-
 * hydration-policy`).
 *
 * Each machine file is bundled by esbuild — tree-shaken, minified, in memory —
 * and the bundle is hashed. The hash therefore changes exactly when code that
 * can execute as part of the machine changes: a guard, action, effect,
 * selector, state, event key or context default, in the machine file or in any
 * module it reaches. Comments, whitespace and exports the machine never uses
 * don't move it. The bundle is a MEASUREMENT, never written or run: what runs
 * stays plain modules with shared instances.
 *
 * External (never bundled, never hashed by content):
 *  - bare specifiers — the framework and node_modules; their versions are hash
 *    inputs instead, so an engine or transform-engine upgrade counts once;
 *  - `.stator` files (a machine has no business importing a template);
 *  - sibling machines (files directly in `machinesDir`) — a machine's hash is
 *    its OWN reachable code, so editing `WeatherMachine` does not reset
 *    `ForecastCache`'s sessions.
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
}

export interface HashMachinesOptions {
  /** The conventional machines directory — files directly in it are siblings. */
  machinesDir: string
}

const statorVersion: string = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version

const OUTDIR = '/__stator_machine_hash__'
const MACHINE_EXT = new Set(['.ts', '.js'])

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
  const isSibling = (abs: string): boolean =>
    dirname(abs) === machinesDir && MACHINE_EXT.has(extname(abs))
  const wanted = new Map(files.map((f) => [real(f), f]))
  const cwd = process.cwd()

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
          b.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return null
            // Bare specifier: a package — external, its version is a hash input.
            if (!args.path.startsWith('.') && !isAbsolute(args.path)) {
              return { path: args.path, external: true }
            }
            const abs = real(resolve(args.resolveDir, args.path))
            // Externals keep their specifier in the bundle, so give siblings and
            // templates a STABLE id (relative to machinesDir), never an absolute
            // path — or the hash would change with the checkout directory.
            if (abs.endsWith('.stator') || isSibling(abs)) {
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
    const hash = createHash('sha256')
      .update(file.contents)
      .update('\0')
      .update(statorVersion)
      .update('\0')
      .update(esbuildVersion)
      .digest('hex')
    // The closure comes from the resolved import GRAPH (`metafile.inputs`),
    // not from `outputs[*].inputs` — that lists only modules that contributed
    // bytes, and a module whose only used export is a constant the minifier
    // inlined contributes none while still being code the machine depends on.
    out.set(entry, { hash, inputs: closureOf(meta.entryPoint, result.metafile.inputs, cwd) })
  }
  for (const f of files) {
    if (!out.has(f)) throw new Error(`stator: no bundle produced for machine ${f}`)
  }
  return out
}

function closureOf(
  entryKey: string,
  inputs: Record<string, { imports: Array<{ path: string; external?: boolean }> }>,
  cwd: string,
): string[] {
  const seen = new Set<string>()
  const stack = [entryKey]
  while (stack.length) {
    const key = stack.pop()!
    if (seen.has(key)) continue
    seen.add(key)
    for (const imp of inputs[key]?.imports ?? []) if (!imp.external) stack.push(imp.path)
  }
  return [...seen].map((k) => resolve(cwd, k))
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
