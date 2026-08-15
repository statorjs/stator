import { resolve } from 'node:path'
import { createDevApp } from '../../server/dev.ts'
import type { CliContext } from '../run.ts'

/** Run the dev server (Vite-backed today: live reload, compile-error overlay,
 *  inspector). The CLI owns the entry so every app's dev flow is identical —
 *  no hand-written `server.ts` to drift across environments. */
export async function run(ctx: CliContext): Promise<void> {
  const app = await createDevApp({
    root: ctx.root,
    machinesDir: resolve(ctx.root, 'machines'),
    routesDir: resolve(ctx.root, 'routes'),
    staticDir: resolve(ctx.root, 'static'),
  })
  await app.listen(ctx.port)
}
