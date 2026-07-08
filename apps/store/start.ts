import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProductionHead } from '@statorjs/stator/build'
import {
  createApp,
  dispatchToApp,
  logger,
  RedisAppStore,
  RedisStore,
} from '@statorjs/stator/server'
import InventoryMachine from './machines/inventory.ts'
import OrdersMachine from './machines/orders.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, 'dist')
const port = Number(process.env.PORT ?? 3000)

try {
  await stat(resolve(dist, 'routes'))
} catch {
  logger.error({}, 'no dist/ found — run `pnpm build` first')
  process.exit(1)
}

// REDIS_URL opts into durable state (sessions slide a short TTL — this is a
// public demo, not a bank); without it, in-memory keeps local `start` simple.
const redisUrl = process.env.REDIS_URL
const app = await createApp({
  machinesDir: resolve(dist, 'machines'),
  routesDir: resolve(dist, 'routes'),
  staticDir: resolve(dist, 'static'),
  headExtras: await loadProductionHead(dist),
  ...(redisUrl
    ? {
        store: new RedisStore(redisUrl),
        appStore: new RedisAppStore(redisUrl),
        sessionTtlSeconds: 2 * 60 * 60,
      }
    : {}),
})

// The tide comes in: reset shared state to seed every 24h so the public demo
// self-heals from drift and vandalism. (Session carts expire via TTL.)
const TIDE_MS = 24 * 60 * 60 * 1000
setInterval(() => {
  void (async () => {
    await dispatchToApp(app.store, InventoryMachine, { type: 'TIDE_RESET' })
    await dispatchToApp(app.store, OrdersMachine, { type: 'TIDE_RESET' })
    logger.info({}, 'tide reset: stock reseeded, orders cleared')
  })().catch((err) => logger.error({ err: String(err) }, 'tide reset failed'))
}, TIDE_MS)

await app.listen(port)
