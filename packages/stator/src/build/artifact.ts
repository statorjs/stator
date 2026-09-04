import { cp, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * The dependency half of the deploy artifact: what `dist/` needs beside its code
 * so the target can materialize `node_modules` itself.
 *
 * The framework never copies `node_modules` into `dist/`. Doing so would bake
 * the build machine's platform into the artifact — `sharp` resolves to
 * `@img/sharp-darwin-arm64` on a Mac and `@img/sharp-linux-x64` in a container,
 * so a traced tree ships a binary that cannot load. Installing on the target is
 * the correct move; the artifact's job is to make that install REPRODUCIBLE.
 *
 * Which means the lockfile is the thing that matters. Resolving dependencies at
 * deploy time is how a deploy picks up a transitive version nobody tested:
 * `npm install` in production is the bug, and `npm ci` (or a frozen `pnpm
 * install`) against a real lockfile is the fix. So:
 *
 *   - **A lockfile beside the app's `package.json`** means the app is
 *     self-contained. Both files are copied VERBATIM, and the target runs
 *     `npm ci --omit=dev` (or `pnpm install --frozen-lockfile --prod`) against
 *     exactly what was locked. A copied manifest also keeps a frozen `pnpm
 *     install` happy, which compares the lockfile's importer manifest against
 *     `package.json` and rejects a synthesized one.
 *
 *   - **No lockfile beside it** means a workspace member: the lockfile lives at
 *     the monorepo root and covers every package, and the manifest may declare
 *     `workspace:*` specifiers that no registry can install. Neither file can
 *     travel, so a manifest is SYNTHESIZED instead — every reached dependency
 *     pinned to the version actually installed at build time, `workspace:*`
 *     included. Direct dependencies are then exact; transitives resolve at
 *     install. That gap is real and is reported, not hidden: for full
 *     reproducibility a workspace app should resolve at build time instead
 *     (`pnpm deploy --prod`, or build inside the image).
 *
 * Pins come from the INSTALLED tree, never from declared ranges. `npm ci`
 * validates the lockfile against the manifest and refuses a mismatch
 * (`Invalid: lock file's debug@4.4.3 does not satisfy debug@4.3.4`), so a pin
 * taken from a range would break the very install this exists to enable.
 */

/** Lockfiles, in the order a package manager would be inferred from them. */
const LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]

/** How the target should install, per lockfile — a frozen install in each case. */
const INSTALL_COMMAND: Record<string, string> = {
  'pnpm-lock.yaml': 'pnpm install --frozen-lockfile --prod',
  'package-lock.json': 'npm ci --omit=dev',
  'npm-shrinkwrap.json': 'npm ci --omit=dev',
  'yarn.lock': 'yarn install --immutable',
  'bun.lock': 'bun install --frozen-lockfile --production',
  'bun.lockb': 'bun install --frozen-lockfile --production',
}

export interface ArtifactDeps {
  /** `copied` — the app's own manifest and lockfile travelled verbatim, so the
   *  install on the target is fully locked. `generated` — a workspace member,
   *  so a pinned manifest was synthesized and transitives resolve at install.
   *  `none` — no `package.json` at the app root. */
  kind: 'copied' | 'generated' | 'none'
  /** Files written into dist, app-relative. */
  files: string[]
  /** The install to run in the artifact, ready to print. */
  install?: string
  /** Dependencies written into a generated manifest, name → exact version. */
  pinned?: Record<string, string>
  /** Reached packages whose installed version could not be read; the declared
   *  range was used instead, so their install is not exactly reproducible. */
  unpinned?: string[]
}

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  )

/**
 * The version actually installed, by walking `node_modules` up from the app
 * root. Deliberately not `require.resolve`: a package with strict `exports` can
 * refuse to expose its own `package.json`, and this needs to work for every
 * dependency, not the well-behaved ones.
 */
async function installedVersion(root: string, name: string): Promise<string | undefined> {
  let dir = root
  for (;;) {
    const manifest = join(dir, 'node_modules', name, 'package.json')
    try {
      const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string') return parsed.version
    } catch {
      // not here — keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Write the artifact's dependency manifest into `outDir`. `packages` is the set
 * of direct dependencies the app's code reached (`CopySet.packages`).
 */
export async function writeArtifactDeps(opts: {
  root: string
  outDir: string
  packages: readonly string[]
}): Promise<ArtifactDeps> {
  const root = resolve(opts.root)
  const outDir = resolve(opts.outDir)
  const manifestPath = join(root, 'package.json')
  if (!(await exists(manifestPath))) return { kind: 'none', files: [] }

  const lockfile = await (async () => {
    for (const name of LOCKFILES) if (await exists(join(root, name))) return name
    return undefined
  })()

  // Self-contained app: both files travel as they are, and the install on the
  // target is locked to exactly what was tested.
  if (lockfile) {
    await cp(manifestPath, join(outDir, 'package.json'))
    await cp(join(root, lockfile), join(outDir, lockfile))
    return {
      kind: 'copied',
      files: ['package.json', lockfile],
      install: INSTALL_COMMAND[lockfile],
    }
  }

  // Workspace member: synthesize a manifest whose pins come from the installed
  // tree, so `workspace:*` becomes a real version and nothing is left to
  // resolve for the direct dependencies.
  const app = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    name?: string
    version?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const pinned: Record<string, string> = {}
  const unpinned: string[] = []
  for (const name of [...opts.packages].sort()) {
    const version = await installedVersion(root, name)
    if (version) {
      pinned[name] = version
      continue
    }
    // Nothing installed to read: fall back to whatever the app declared, and
    // say so — this dependency's install is not exactly reproducible.
    const declared = app.dependencies?.[name] ?? app.devDependencies?.[name]
    if (declared && !declared.startsWith('workspace:')) pinned[name] = declared
    else pinned[name] = '*'
    unpinned.push(name)
  }

  const generated = {
    name: app.name ?? 'stator-app',
    version: app.version ?? '0.0.0',
    private: true,
    // dist has no package.json of its own today, so Node walks up and inherits
    // the app's `type`. Once the artifact is the deploy root there is nothing
    // above it to inherit from.
    type: 'module',
    dependencies: pinned,
    scripts: { start: 'stator start' },
  }
  await writeFile(join(outDir, 'package.json'), `${JSON.stringify(generated, null, 2)}\n`)
  return {
    kind: 'generated',
    files: ['package.json'],
    install: 'npm install --omit=dev',
    pinned,
    ...(unpinned.length > 0 ? { unpinned } : {}),
  }
}
