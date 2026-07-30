import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discoverMachines } from '../src/server/discovery.ts'
import {
  type DiscoveredRoute,
  discoverRoutes,
  filePathToRoute,
  sortRoutes,
} from '../src/server/route-discovery.ts'

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
      /exports GET from defineApiRoute\(\) without method: 'GET'/,
    )
  })

  it("errors on a method: 'GET' definition exported under a mutation method", async () => {
    await expect(discoverRoutes(resolve(here, 'fixtures', 'route-query-as-post'))).rejects.toThrow(
      /exports POST created with method: 'GET'/,
    )
  })

  it('errors on an extension-named route file that exports no route', async () => {
    await expect(discoverRoutes(resolve(here, 'fixtures', 'route-ext-no-exports'))).rejects.toThrow(
      /named like a data route/,
    )
  })
})

describe('discovery: data GET routes', () => {
  it('accepts a data GET and maps the extension-named file to its extension URL', async () => {
    const routes = await discoverRoutes(resolve(here, 'fixtures', 'route-data-get'))
    expect(routes).toHaveLength(1)
    expect(routes[0]!.urlPath).toBe('/report.json')
    expect(routes[0]!.GET).toMatchObject({ __isStatorQueryRoute: true })
  })
})

describe('discovery: param segments with extension suffix', () => {
  it('[id].json.ts maps to :id.json with param id', () => {
    expect(filePathToRoute('/r', '/r/p/[id].json.ts')).toEqual({
      urlPath: '/p/:id.json',
      paramNames: ['id'],
    })
  })

  it('a rest segment cannot carry a suffix', () => {
    expect(() => filePathToRoute('/r', '/r/[...path].json.ts')).toThrow(/rest segment/)
  })

  it('the suffixed param outranks the bare param at one URL depth', () => {
    const stub = (urlPath: string) => ({ urlPath, paramNames: [], filePath: '' }) as DiscoveredRoute
    const sorted = sortRoutes([stub('/p/:id'), stub('/p/:id.json')])
    expect(sorted.map((r) => r.urlPath)).toEqual(['/p/:id.json', '/p/:id'])
  })
})
