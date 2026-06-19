import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stat } from 'node:fs/promises'
import {
  createApp,
  InMemoryStore,
  RedisStore,
  CachedStore,
  logger,
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
  store = new CachedStore(new RedisStore(redisUrl), { memoryTtlSeconds: 300, maxEntries: 10_000 })
} else {
  store = new InMemoryStore()
  logger.warn({ store: 'in-memory' }, 'sessions will not survive restart')
}

let hasCss = false
try {
  await stat(resolve(dist, 'static', 'components.css'))
  hasCss = true
} catch {
  // no scoped component styles
}

const app = await createApp({
  machinesDir: resolve(dist, 'machines'),
  routesDir: resolve(dist, 'routes'),
  staticDir: resolve(dist, 'static'),
  store,
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 86400),
  headExtras: hasCss
    ? () => '<link rel="stylesheet" href="/static/components.css">'
    : undefined,
})

await app.listen(port)
