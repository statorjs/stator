import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadProductionHead } from '../../build/index.ts'
import { createApp } from '../../server/index.ts'
import { loadConfig, resolvePort } from '../config.ts'
import type { CliContext } from '../run.ts'

/** Serve a built `dist/` in production mode (no Vite). Same `stator.config.ts`
 *  as `dev` supplies the store/session/port. */
export async function run(ctx: CliContext): Promise<void> {
  const dist = resolve(ctx.root, 'dist')
  try {
    await stat(resolve(dist, 'routes'))
  } catch {
    throw new Error('no dist/ found — run `stator build` first')
  }

  const config = await loadConfig(ctx.root)
  const { headExtras, buildId, machines } = await loadProductionHead(dist)
  const app = await createApp({
    machinesDir: resolve(dist, 'machines'),
    routesDir: resolve(dist, 'routes'),
    staticDir: resolve(dist, 'static'),
    persistence: config.persistence,
    sessions: config.sessions,
    realtime: config.realtime,
    images: config.images,
    trustedOrigins: config.trustedOrigins,
    origin: config.origin,
    host: config.host,
    secret: config.secret,
    cors: config.cors,
    logging: config.logging,
    headExtras,
    buildId,
    machineHashes: machines,
    middlewareFile: resolve(dist, 'middleware.ts'),
    bootFile: resolve(dist, 'boot.ts'),
  })

  await app.listen(resolvePort(ctx.portFlag, config.port))
}
