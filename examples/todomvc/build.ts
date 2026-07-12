import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '@statorjs/stator/build'

const here = dirname(fileURLToPath(import.meta.url))
const result = await buildApp({ root: here, outDir: resolve(here, 'dist') })
console.log(`stator: built ${result.compiled} components → ${result.outDir}`)
