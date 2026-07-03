import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevApp } from '@statorjs/stator/dev'
import { CachedStore, InMemoryStore, logger, RedisStore, type Store } from '@statorjs/stator/server'

const here = dirname(fileURLToPath(import.meta.url))

const redisUrl = process.env.REDIS_URL
const port = Number(process.env.PORT ?? 3000)

let store: Store
if (redisUrl) {
  // Cache-in-front-of-Redis. Cuts Upstash command counts ~50% on chatty
  // sessions without changing durability — writes are write-through, so a
  // crash loses only the cache, not state.
  store = new CachedStore(new RedisStore(redisUrl), {
    memoryTtlSeconds: 300,
    maxEntries: 10_000,
  })
  logger.info({ store: 'redis+cache', url: redactUrl(redisUrl) }, 'persistence adapter selected')
} else {
  store = new InMemoryStore()
  logger.warn(
    { store: 'in-memory' },
    'persistence adapter selected — sessions will not survive restart',
  )
}

// Dev server: Vite compiles `.stator` templates on the way in. The production
// serve path (pre-built assets, no Vite) is a separate follow-up; until it
// lands, the example runs through the dev server.
const app = await createDevApp({
  root: here,
  machinesDir: resolve(here, 'machines'),
  routesDir: resolve(here, 'routes'),
  staticDir: resolve(here, 'static'),
  store,
  // 24h session idle window; refreshes on any cart action. Adjust via
  // env if you need a shorter demo window.
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 86400),
})

await app.listen(port)

function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '<unparseable>'
  }
}
