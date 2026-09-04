import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { loadProductionHead } from '../../build/index.ts'
import { createApp } from '../../server/index.ts'
import { loadConfig, resolvePort } from '../config.ts'
import type { CliContext } from '../run.ts'

const running: string = (
  createRequire(import.meta.url)('../../../package.json') as { version: string }
).version

/** Same major.minor. A patch cannot change what the compiler emitted; a minor
 *  can, and the artifact was emitted by one specific compiler. */
const emitCompatible = (built: string, current: string): boolean =>
  built.split('.').slice(0, 2).join('.') === current.split('.').slice(0, 2).join('.')

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  )

/**
 * Serve a built artifact in production (no Vite).
 *
 * Everything comes from the artifact, `stator.config.ts` included. There is
 * deliberately no fall back to the source tree: a config read from outside the
 * artifact makes `dist/` a lie — the same build would then behave one way from
 * a repo checkout and another way from a copied `dist/`, and a deploy that
 * shipped only `dist/` would find no config at all and start on in-memory
 * persistence without saying a word. It is also how two copies of a module end
 * up live in one process: a root config importing `./lib/db.ts` while the
 * machines import `dist/lib/db.ts` means two connections, two caches, and two
 * versions of the same code.
 */
export async function run(ctx: CliContext): Promise<void> {
  // The artifact can be the deploy root itself: point `--root` at a directory
  // holding the manifest beside `routes/` and it is served in place, so `dist/`
  // can be the only directory copied to a server.
  const inPlace =
    (await exists(resolve(ctx.root, 'stator-manifest.json'))) &&
    (await exists(resolve(ctx.root, 'routes')))
  const dist = inPlace ? resolve(ctx.root) : resolve(ctx.root, 'dist')

  if (!(await exists(resolve(dist, 'routes')))) {
    throw new Error('no dist/ found — run `stator build` first')
  }

  const {
    headExtras,
    buildId,
    machines,
    config: configFile,
    statorVersion: builtWith,
  } = await loadProductionHead(dist)

  // The artifact holds output emitted by one specific compiler. Running it
  // against a different framework minor means the runtime and the emit
  // disagree, and the failures are obscure — a template read that reports it
  // was called outside a render, because two copies of the framework hold
  // separate render state. An app whose lockfile pins an older version than
  // the machine that built it produces exactly this, silently.
  if (builtWith && !emitCompatible(builtWith, running)) {
    throw new Error(
      `this dist was compiled by @statorjs/stator ${builtWith} but ${running} is running — ` +
        `rebuild with the installed version, or install ${builtWith} in the artifact`,
    )
  }

  // An artifact built before the manifest recorded its config cannot be trusted
  // to be complete: "no config" and "the config didn't travel" look identical,
  // and guessing wrong silently downgrades persistence.
  if (configFile === undefined) {
    throw new Error(
      'this dist was built by an older stator and does not record its config — run `stator build` again',
    )
  }
  if (configFile !== null && !(await exists(resolve(dist, configFile)))) {
    throw new Error(
      `dist is incomplete: the build recorded ${configFile} but it is not in the artifact — copy the whole directory, or rebuild`,
    )
  }

  const config = await loadConfig(dist)
  const app = await createApp({
    machinesDir: resolve(dist, 'machines'),
    routesDir: resolve(dist, 'routes'),
    staticDir: resolve(dist, 'static'),
    persistence: config.persistence,
    sessions: config.sessions,
    realtime: config.realtime,
    trustedOrigins: config.trustedOrigins,
    origin: config.origin,
    host: config.host,
    secret: config.secret,
    cors: config.cors,
    headExtras,
    buildId,
    machineHashes: machines,
    middlewareFile: resolve(dist, 'middleware.ts'),
    bootFile: resolve(dist, 'boot.ts'),
  })

  await app.listen(resolvePort(ctx.portFlag, config.port))
}
