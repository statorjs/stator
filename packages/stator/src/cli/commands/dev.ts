import { resolve } from 'node:path'
import { createDevApp, createNativeDevApp } from '../../server/dev.ts'
import { loadConfig, resolvePort } from '../config.ts'
import type { CliContext } from '../run.ts'

/** Run the dev server. Live reload, inspector, conventions for machines/routes/
 *  static; `stator.config.ts` for the store/session/port an app previously
 *  hand-wrote a `server.ts` for.
 *
 *  `STATOR_NATIVE_DEV=1` opts into the Vite-free native dev server (Option D,
 *  in development) instead of the Vite-backed default. */
export async function run(ctx: CliContext): Promise<void> {
  const config = await loadConfig(ctx.root)
  const create = process.env.STATOR_NATIVE_DEV === '1' ? createNativeDevApp : createDevApp
  const app = await create({
    root: ctx.root,
    machinesDir: resolve(ctx.root, 'machines'),
    routesDir: resolve(ctx.root, 'routes'),
    staticDir: resolve(ctx.root, 'static'),
    persistence: config.persistence,
    sessions: config.sessions,
    dev: config.dev,
    trustedOrigins: config.trustedOrigins,
    origin: config.origin,
    cors: config.cors,
  })
  await app.listen(resolvePort(ctx.portFlag, config.port))
}
