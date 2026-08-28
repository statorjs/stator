import { resolve } from 'node:path'
import { createDevApp } from '../../server/dev.ts'
import { loadConfig, resolvePort } from '../config.ts'
import type { CliContext } from '../run.ts'

/** Run the dev server. Live reload, inspector, conventions for machines/routes/
 *  static; `stator.config.ts` for the store/session/port an app previously
 *  hand-wrote a `server.ts` for.
 *
 *  The app runs natively from its source tree, exactly as `stator start` runs a
 *  build. `STATOR_VITE_DEV=1` keeps the previous Vite-embedded dev server for
 *  one minor as an escape hatch. */
export async function run(ctx: CliContext): Promise<void> {
  const config = await loadConfig(ctx.root)
  const app = await createDevApp({
    root: ctx.root,
    machinesDir: resolve(ctx.root, 'machines'),
    routesDir: resolve(ctx.root, 'routes'),
    staticDir: resolve(ctx.root, 'static'),
    persistence: config.persistence,
    sessions: config.sessions,
    dev: config.dev,
    images: config.images,
    trustedOrigins: config.trustedOrigins,
    origin: config.origin,
    cors: config.cors,
    secret: config.secret,
    logging: config.logging,
  })
  await app.listen(resolvePort(ctx.portFlag, config.port))
}
