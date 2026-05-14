import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, InMemoryStore, RedisStore, logger, type Store } from 'stator/server'

const here = dirname(fileURLToPath(import.meta.url))

const redisUrl = process.env.REDIS_URL
const port = Number(process.env.PORT ?? 3000)

let store: Store
if (redisUrl) {
  store = new RedisStore(redisUrl)
  logger.info({ store: 'redis', url: redactUrl(redisUrl) }, 'persistence adapter selected')
} else {
  store = new InMemoryStore()
  logger.warn(
    { store: 'in-memory' },
    'persistence adapter selected — sessions will not survive restart',
  )
}

const app = await createApp({
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
