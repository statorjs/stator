import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncTypes } from '@statorjs/stator/build'

const here = dirname(fileURLToPath(import.meta.url))
const { written } = await syncTypes(here)
console.log(`stator: wrote ${written} .stator.d.ts files`)
