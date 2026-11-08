import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { type DiscoveredRoute, filePathToRoute, sortRoutes } from '../src/server/route-discovery.ts'

const DIR = resolve('/app/routes')
function path(file: string) {
  return filePathToRoute(DIR, resolve(DIR, file)).urlPath
}
function params(file: string) {
  return filePathToRoute(DIR, resolve(DIR, file)).paramNames
}

describe('routing: file path → url pattern', () => {
  it('maps compiled .stator.ts routes to the same URLs as their .stator source', () => {
    assert.equal(path('index.stator.ts'), '/')
    assert.equal(path('about.stator.ts'), '/about')
    assert.equal(path('shop/[id].stator.ts'), '/shop/:id')
  })

  it('maps index and static segments', () => {
    assert.equal(path('index.stator'), '/')
    assert.equal(path('about.stator'), '/about')
    assert.equal(path('shop/cart.ts'), '/shop/cart')
  })

  it('maps named params [id]', () => {
    assert.equal(path('p/[id].stator'), '/p/:id')
    assert.deepStrictEqual(params('p/[id].stator'), ['id'])
  })

  it('maps rest params [...slug] to *slug', () => {
    assert.equal(path('[...slug].stator'), '/*slug')
    assert.deepStrictEqual(params('docs/[...path].ts'), ['path'])
    assert.equal(path('docs/[...path].ts'), '/docs/*path')
  })
})

describe('routing: specificity sort (most-specific first)', () => {
  const make = (urlPath: string): DiscoveredRoute => ({
    urlPath,
    paramNames: [],
    filePath: urlPath,
    GET: {} as never,
  })

  function order(paths: string[]): string[] {
    return sortRoutes(paths.map(make)).map((r) => r.urlPath)
  }

  it('static beats param beats rest', () => {
    assert.deepStrictEqual(order(['/*slug', '/:id', '/about']), ['/about', '/:id', '/*slug'])
  })

  it('index (/) beats a root catch-all', () => {
    assert.deepStrictEqual(order(['/*slug', '/']), ['/', '/*slug'])
  })

  it('per-segment left-to-right specificity', () => {
    // /shop/cart (static,static) > /shop/:id (static,param) > /:a/:b (param,param)
    assert.deepStrictEqual(order(['/:a/:b', '/shop/:id', '/shop/cart']), [
      '/shop/cart',
      '/shop/:id',
      '/:a/:b',
    ])
  })

  it('more segments before fewer when kinds match', () => {
    assert.deepStrictEqual(order(['/a', '/a/b/c', '/a/b']), ['/a/b/c', '/a/b', '/a'])
  })

  it('ties resolved alphabetically', () => {
    assert.deepStrictEqual(order(['/beta', '/alpha']), ['/alpha', '/beta'])
  })
})
