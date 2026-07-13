import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProductionHead } from '@statorjs/stator/build'
import {
  CachedStore,
  createApp,
  InMemoryStore,
  logger,
  RedisStore,
  type Store,
} from '@statorjs/stator/server'

/**
 * Production server: serves the prebuilt `dist/` with no Vite. Run `pnpm build`
 * first. The dev server (`server.ts`) compiles `.stator` on the fly via Vite;
 * this path runs the compiled output through the plain runtime.
 */
const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, 'dist')
const port = Number(process.env.PORT ?? 3000)

try {
  await stat(resolve(dist, 'routes'))
} catch {
  logger.error({}, 'no dist/ found — run `pnpm build` first')
  process.exit(1)
}

const redisUrl = process.env.REDIS_URL
let store: Store
if (redisUrl) {
  store = new CachedStore(new RedisStore(redisUrl), {
    memoryTtlSeconds: 300,
    maxEntries: 10_000,
  })
} else {
  store = new InMemoryStore()
  logger.warn({ store: 'in-memory' }, 'sessions will not survive restart')
}

const app = await createApp({
  machinesDir: resolve(dist, 'machines'),
  routesDir: resolve(dist, 'routes'),
  staticDir: resolve(dist, 'static'),
  store,
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 86400),
  // Links components.css and injects each route's island module scripts
  // from stator-manifest.json (both written by buildApp).
  headExtras: await loadProductionHead(dist),
})

await app.listen(port)
