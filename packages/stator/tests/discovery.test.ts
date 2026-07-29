import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discoverMachines } from '../src/server/discovery.ts'
import { discoverRoutes } from '../src/server/route-discovery.ts'

const here = dirname(fileURLToPath(import.meta.url))
const missing = resolve(here, 'fixtures', '__does_not_exist__')
const mismatch = resolve(here, 'fixtures', 'route-mismatch')

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

describe('discovery: method/constructor mismatch', () => {
  it('errors on a file whose ONLY export is a mis-constructed GET (never a silent skip)', async () => {
    // The mismatch check must run before the not-a-route skip: with GET as the
    // file's sole export, a skip-first order treats it as a utility file.
    await expect(discoverRoutes(mismatch)).rejects.toThrow(
      /exports GET but it is not a defineRoute/,
    )
  })
})
