import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevApp } from '@statorjs/stator/dev'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT ?? 3007)

// Dev server: Vite compiles `.stator` on the way in, with live reload and the
// inspector toolbar. Production runs `pnpm build && pnpm start` instead.
// The book is an app machine with `persist: true` — pass an AppStore (e.g.
// RedisAppStore) to createApp in production for entries that survive restarts.
const app = await createDevApp({
  root: here,
  machinesDir: resolve(here, 'machines'),
  routesDir: resolve(here, 'routes'),
  staticDir: resolve(here, 'static'),
})

await app.listen(port)
