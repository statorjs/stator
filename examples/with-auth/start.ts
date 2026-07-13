import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProductionHead } from '@statorjs/stator/build'
import { createApp, logger } from '@statorjs/stator/server'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, 'dist')
const port = Number(process.env.PORT ?? 3000)

try {
  await stat(resolve(dist, 'routes'))
} catch {
  logger.error({}, 'no dist/ found — run `pnpm build` first')
  process.exit(1)
}

const app = await createApp({
  machinesDir: resolve(dist, 'machines'),
  routesDir: resolve(dist, 'routes'),
  staticDir: resolve(dist, 'static'),
  headExtras: await loadProductionHead(dist),
})

await app.listen(port)
