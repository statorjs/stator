import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type DiscoveredRoute, filePathToRoute, sortRoutes } from '../src/server/route-discovery.ts'

const DIR = resolve('/app/routes')
function path(file: string) {
  return filePathToRoute(DIR, resolve(DIR, file)).urlPath
}
function params(file: string) {
  return filePathToRoute(DIR, resolve(DIR, file)).paramNames
}

describe('routing: file path → url pattern', () => {
  it('maps index and static segments', () => {
    expect(path('index.stator')).toBe('/')
    expect(path('about.stator')).toBe('/about')
    expect(path('shop/cart.ts')).toBe('/shop/cart')
  })

  it('maps named params [id]', () => {
    expect(path('p/[id].stator')).toBe('/p/:id')
    expect(params('p/[id].stator')).toEqual(['id'])
  })

  it('maps rest params [...slug] to *slug', () => {
    expect(path('[...slug].stator')).toBe('/*slug')
    expect(params('docs/[...path].ts')).toEqual(['path'])
    expect(path('docs/[...path].ts')).toBe('/docs/*path')
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
    expect(order(['/*slug', '/:id', '/about'])).toEqual(['/about', '/:id', '/*slug'])
  })

  it('index (/) beats a root catch-all', () => {
    expect(order(['/*slug', '/'])).toEqual(['/', '/*slug'])
  })

  it('per-segment left-to-right specificity', () => {
    // /shop/cart (static,static) > /shop/:id (static,param) > /:a/:b (param,param)
    expect(order(['/:a/:b', '/shop/:id', '/shop/cart'])).toEqual([
      '/shop/cart',
      '/shop/:id',
      '/:a/:b',
    ])
  })

  it('more segments before fewer when kinds match', () => {
    expect(order(['/a', '/a/b/c', '/a/b'])).toEqual(['/a/b/c', '/a/b', '/a'])
  })

  it('ties resolved alphabetically', () => {
    expect(order(['/beta', '/alpha'])).toEqual(['/alpha', '/beta'])
  })
})
