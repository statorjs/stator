import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadProductionHead } from '../../build/index.ts'
import { createApp } from '../../server/index.ts'
import type { CliContext } from '../run.ts'

/** Serve a built `dist/` in production mode (no Vite). */
export async function run(ctx: CliContext): Promise<void> {
  const dist = resolve(ctx.root, 'dist')
  try {
    await stat(resolve(dist, 'routes'))
  } catch {
    throw new Error('no dist/ found — run `stator build` first')
  }

  const app = await createApp({
    machinesDir: resolve(dist, 'machines'),
    routesDir: resolve(dist, 'routes'),
    staticDir: resolve(dist, 'static'),
    headExtras: await loadProductionHead(dist),
  })

  await app.listen(ctx.port)
}
