import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from 'stator/server'

const here = dirname(fileURLToPath(import.meta.url))

const app = await createApp({
  machinesDir: resolve(here, 'machines'),
  routesDir: resolve(here, 'routes'),
  staticDir: resolve(here, 'static'),
})

await app.listen(3000)
