import { describe, it, expect } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverMachines } from '../src/server/discovery.ts'
import { discoverRoutes } from '../src/server/route-discovery.ts'

const here = dirname(fileURLToPath(import.meta.url))
const missing = resolve(here, 'fixtures', '__does_not_exist__')

describe('discovery: missing conventional dir', () => {
  it('discoverMachines treats a missing dir as no machines (no ENOENT crash)', async () => {
    const { defs } = await discoverMachines(missing)
    expect(defs).toEqual([])
  })

  it('discoverRoutes treats a missing dir as no routes', async () => {
    const routes = await discoverRoutes(missing)
    expect(routes).toEqual([])
  })

  it('still surfaces a non-ENOENT error', async () => {
    // A file path (not a dir) yields ENOTDIR — must not be swallowed.
    const aFile = resolve(here, 'discovery.test.ts')
    await expect(discoverMachines(aFile)).rejects.toThrow()
  })
})
