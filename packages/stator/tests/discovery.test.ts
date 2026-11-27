import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { discoverMachines } from '../src/server/discovery.ts'
import {
  type DiscoveredRoute,
  discoverRoutes,
  filePathToRoute,
  sortRoutes,
} from '../src/server/route-discovery.ts'
import { defineApiRoute } from '../src/server/routing.ts'

const here = dirname(fileURLToPath(import.meta.url))
const missing = resolve(here, 'fixtures', '__does_not_exist__')
const mismatch = resolve(here, 'fixtures', 'route-mismatch')

describe('discovery: missing conventional dir', () => {
  it('discoverMachines treats a missing dir as no machines (no ENOENT crash)', async () => {
    const { defs } = await discoverMachines(missing)
    assert.deepStrictEqual(defs, [])
  })

  it('discoverRoutes treats a missing dir as no routes', async () => {
    const routes = await discoverRoutes(missing)
    assert.deepStrictEqual(routes, [])
  })

  it('still surfaces a non-ENOENT error', async () => {
    // A file path (not a dir) yields ENOTDIR — must not be swallowed.
    const aFile = resolve(here, 'discovery.test.ts')
    await assert.rejects(discoverMachines(aFile))
  })
})

describe('discovery: method/constructor mismatch', () => {
  it('errors on a file whose ONLY export is a mis-constructed GET (never a silent skip)', async () => {
    // The mismatch check must run before the not-a-route skip: with GET as the
    // file's sole export, a skip-first order treats it as a utility file.
    await assert.rejects(
      discoverRoutes(mismatch),
      /exports GET from defineApiRoute\(\) without method: 'GET'/,
    )
  })

  it("errors on a method: 'GET' definition exported under a mutation method", async () => {
    await assert.rejects(
      discoverRoutes(resolve(here, 'fixtures', 'route-query-as-post')),
      /exports POST created with method: 'GET'/,
    )
  })

  it('errors on a command route whose declared method differs from its export name', async () => {
    await assert.rejects(
      discoverRoutes(resolve(here, 'fixtures', 'route-method-mismatch')),
      /bad\.ts exports DELETE created with method: 'POST' — the declared method must match the export name/,
    )
  })

  it('names the declared method when a command route is exported as GET', async () => {
    await assert.rejects(
      discoverRoutes(resolve(here, 'fixtures', 'route-method-on-get')),
      /exports GET created with method: 'POST'\. A GET is a page \(defineRoute\) or a data route/,
    )
  })

  it('loads a command route with a matching declared method, and one without', async () => {
    const routes = await discoverRoutes(resolve(here, 'fixtures', 'route-method-match'))
    assert.equal(routes.length, 1)
    assert.partialDeepStrictEqual(routes[0]!.DELETE, { __isStatorApiRoute: true, method: 'DELETE' })
    assert.equal(routes[0]!.PUT?.__isStatorApiRoute, true)
    assert.equal(routes[0]!.PUT?.method, undefined)
  })

  it('errors on an extension-named route file that exports no route', async () => {
    await assert.rejects(
      discoverRoutes(resolve(here, 'fixtures', 'route-ext-no-exports')),
      /named like a data route/,
    )
  })
})

describe('defineApiRoute: method', () => {
  it('keeps a declared command method on the definition', () => {
    const def = defineApiRoute({ method: 'PATCH', handler: () => ({}) })
    assert.equal(def.method, 'PATCH')
    assert.equal('method' in defineApiRoute({ handler: () => ({}) }), false)
  })

  it('throws at definition time on a method outside HTTP_METHODS', () => {
    assert.throws(
      // Reachable from JavaScript or through a cast; lowercase is not normalised.
      () => defineApiRoute({ method: 'post' as 'POST', handler: () => ({}) }),
      /stator: defineApiRoute method must be one of GET, POST, PUT, PATCH, DELETE — got "post"\./,
    )
  })
})

describe('discovery: data GET routes', () => {
  it('accepts a data GET and maps the extension-named file to its extension URL', async () => {
    const routes = await discoverRoutes(resolve(here, 'fixtures', 'route-data-get'))
    assert.equal(routes.length, 1)
    assert.equal(routes[0]!.urlPath, '/report.json')
    assert.partialDeepStrictEqual(routes[0]!.GET, { __isStatorQueryRoute: true })
  })
})

describe('discovery: param segments with extension suffix', () => {
  it('[id].json.ts maps to :id.json with param id', () => {
    assert.deepStrictEqual(filePathToRoute('/r', '/r/p/[id].json.ts'), {
      urlPath: '/p/:id.json',
      paramNames: ['id'],
      isNotFoundFallback: false,
    })
  })

  it('a rest segment cannot carry a suffix', () => {
    assert.throws(() => filePathToRoute('/r', '/r/[...path].json.ts'), /rest segment/)
  })

  it('the suffixed param outranks the bare param at one URL depth', () => {
    const stub = (urlPath: string) => ({ urlPath, paramNames: [], filePath: '' }) as DiscoveredRoute
    const sorted = sortRoutes([stub('/p/:id'), stub('/p/:id.json')])
    assert.deepStrictEqual(
      sorted.map((r) => r.urlPath),
      ['/p/:id.json', '/p/:id'],
    )
  })
})

describe('discovery: 404 convention (sugar for a synthesized [...name] catch-all)', () => {
  it('routes/404.ts at the root synthesizes a root catch-all, flagged isNotFoundFallback', () => {
    const result = filePathToRoute('/r', '/r/404.ts')
    assert.equal(result.isNotFoundFallback, true)
    assert.equal(result.urlPath.startsWith('/*'), true)
    assert.equal(result.paramNames.length, 1)
  })

  it('routes/admin/404.stator synthesizes a catch-all scoped to /admin', () => {
    const result = filePathToRoute('/r', '/r/admin/404.stator')
    assert.equal(result.isNotFoundFallback, true)
    assert.equal(result.urlPath.startsWith('/admin/*'), true)
  })

  it('a plain [...name].ts is NOT flagged as the 404 fallback', () => {
    const result = filePathToRoute('/r', '/r/[...name].ts')
    assert.equal(result.isNotFoundFallback, false)
  })

  it('sortRoutes forces isNotFoundFallback below a real [...name] catch-all at the same depth', () => {
    const stub = (urlPath: string, isNotFoundFallback = false) =>
      ({ urlPath, paramNames: [], filePath: '', isNotFoundFallback }) as DiscoveredRoute
    const real = stub('/*name')
    const fallback = stub('/*__stator_notfound__', true)
    // Regardless of input order, or how they'd otherwise compare
    // alphabetically (this exact pair would sort the "wrong" way on
    // urlPath alone — '__stator_notfound__' < 'name' — without the
    // isNotFoundFallback tiebreak taking priority).
    assert.deepStrictEqual(
      sortRoutes([fallback, real]).map((r) => r.urlPath),
      ['/*name', '/*__stator_notfound__'],
    )
    assert.deepStrictEqual(
      sortRoutes([real, fallback]).map((r) => r.urlPath),
      ['/*name', '/*__stator_notfound__'],
    )
  })

  it('sortRoutes still puts isNotFoundFallback dead last even against ordinary static/param routes', () => {
    const stub = (urlPath: string, isNotFoundFallback = false) =>
      ({ urlPath, paramNames: [], filePath: '', isNotFoundFallback }) as DiscoveredRoute
    const sorted = sortRoutes([
      stub('/*__stator_notfound__', true),
      stub('/posts/:slug'),
      stub('/about'),
      stub('/*name'),
    ])
    assert.deepStrictEqual(
      sorted.map((r) => r.urlPath),
      ['/posts/:slug', '/about', '/*name', '/*__stator_notfound__'],
    )
  })
})
