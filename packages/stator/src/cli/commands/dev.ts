import { resolve } from 'node:path'
import { createDevApp } from '../../server/dev.ts'
import { loadConfig, resolvePort } from '../config.ts'
import type { CliContext } from '../run.ts'

/** Run the dev server (Vite-backed today: live reload, compile-error overlay,
 *  inspector). Conventions for machines/routes/static; `stator.config.ts` for
 *  the store/session/port an app previously hand-wrote a `server.ts` for. */
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
    trustedOrigins: config.trustedOrigins,
  })
  await app.listen(resolvePort(ctx.portFlag, config.port))
}
