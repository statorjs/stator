import { describe, expect, it } from 'vitest'
import { buildHonoApp } from '../src/server/http.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { type DiscoveredRoute, sortRoutes } from '../src/server/route-discovery.ts'
import { defineApiRoute, defineRoute } from '../src/server/routing.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { html } from '../src/template/html.ts'

/**
 * A GET route's own 404 no longer permanently claims the path — the next-
 * most-specific matching route gets a turn, cascading down the same
 * priority order route discovery already sorts by (`matchAllPaths`/
 * `matchers`, http.ts). Built directly against `buildHonoApp` with
 * hand-constructed `DiscoveredRoute`s rather than real route FILES: file-
 * based discovery for a `[param]`/`[...rest]` filename requires a dynamic
 * `import()` of a bracket-containing path, which the in-process `createApp`
 * loader can't do when run through Vitest's own transform pipeline (a
 * pre-existing gap unrelated to this feature — the framework's own real
 * bracket-route fixtures are only ever exercised via a spawned subprocess,
 * see dev-native.test.ts). `buildHonoApp` takes `routes: DiscoveredRoute[]`
 * directly and preserves that array's order as match priority with no
 * re-sorting, so this tests the exact dispatch-loop/cascading logic without
 * needing real files at all — a more precise unit boundary for this feature
 * than an integration test would be anyway.
 *
 * Covers both GET code paths that converge on the same dispatch loop: data
 * routes (a raw Response, e.g. routes/media/[...path].ts's real shape) and
 * page routes (ctx.response.status, the .stator-equivalent — the exact case
 * that exposed the status-clobbering bug the isolation fix closes).
 *
 * Routes are run through the real `sortRoutes` before reaching
 * `buildHonoApp` (which itself preserves whatever order it's given, no
 * re-sorting) — real `discoverRoutes` does the same, so this exercises the
 * actual priority `matchAllPaths` will see, not just "however I happened to
 * list them here."
 */
async function appWithRoutes(routes: DiscoveredRoute[]) {
  const store = new MachineStore([], new InMemoryStore())
  const hono = await buildHonoApp({ routes: sortRoutes(routes), store })
  return hono
}

function dataRoute(
  urlPath: string,
  paramNames: string[],
  get: DiscoveredRoute['GET'],
  isNotFoundFallback?: boolean,
): DiscoveredRoute {
  return { urlPath, paramNames, filePath: `<test>${urlPath}`, GET: get, isNotFoundFallback }
}

const pageRoute = dataRoute

describe('cascading 404s', () => {
  it('data route: a more specific match that succeeds wins outright — no cascade needed', async () => {
    const specific = dataRoute(
      '/posts/:slug',
      ['slug'],
      defineApiRoute({
        method: 'GET',
        handler: (request) =>
          request.params.slug === 'known'
            ? new Response('specific: known post', { status: 200 })
            : new Response('specific: not found', { status: 404 }),
      }),
    )
    const catchAll = dataRoute(
      '/posts/*rest',
      ['rest'],
      defineApiRoute({
        method: 'GET',
        handler: (request) =>
          new Response(`catch-all: ${request.params.rest ?? ''}`, { status: 200 }),
      }),
    )
    const app = await appWithRoutes([specific, catchAll])

    const res = await app.fetch(new Request('http://localhost/posts/known'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('specific: known post')
  })

  it('data route: a 404 from the specific match cascades into the catch-all, which succeeds', async () => {
    const specific = dataRoute(
      '/posts/:slug',
      ['slug'],
      defineApiRoute({
        method: 'GET',
        handler: (request) =>
          request.params.slug === 'known'
            ? new Response('specific: known post', { status: 200 })
            : new Response('specific: not found', { status: 404 }),
      }),
    )
    const catchAll = dataRoute(
      '/posts/*rest',
      ['rest'],
      defineApiRoute({
        method: 'GET',
        handler: (request) =>
          new Response(`catch-all: ${request.params.rest ?? ''}`, { status: 200 }),
      }),
    )
    const app = await appWithRoutes([specific, catchAll])

    const res = await app.fetch(new Request('http://localhost/posts/unknown-slug'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('catch-all: unknown-slug')
  })

  it('data route: every matching candidate 404ing returns the LAST one’s own response, not a generic 404', async () => {
    const specific = dataRoute(
      '/dead-end/:slug',
      ['slug'],
      defineApiRoute({
        method: 'GET',
        handler: () =>
          new Response('specific dead end', {
            status: 404,
            headers: { 'X-Candidate': 'specific' },
          }),
      }),
    )
    const catchAll = dataRoute(
      '/dead-end/*rest',
      ['rest'],
      defineApiRoute({
        method: 'GET',
        handler: () =>
          new Response('catch-all dead end', {
            status: 404,
            headers: { 'X-Candidate': 'catch-all' },
          }),
      }),
    )
    const app = await appWithRoutes([specific, catchAll])

    const res = await app.fetch(new Request('http://localhost/dead-end/anything'))
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('catch-all dead end')
    expect(res.headers.get('x-candidate')).toBe('catch-all')
  })

  it('page route: a more specific match that succeeds wins outright, status 200', async () => {
    const specific = pageRoute(
      '/pages/:slug',
      ['slug'],
      defineRoute({
        reads: [],
        render: (ctx: any, request: any) => {
          if (request.params.slug !== 'known') {
            ctx.response.status = 404
            return html`<!doctype html>
              <html>
                <body>specific page: not found</body>
              </html>`
          }
          return html`<!doctype html>
            <html>
              <body>specific page: known</body>
            </html>`
        },
      }),
    )
    const catchAll = pageRoute(
      '/pages/*rest',
      ['rest'],
      defineRoute({
        reads: [],
        render: () => html`<!doctype html>
          <html>
            <body>catch-all page</body>
          </html>`,
      }),
    )
    const app = await appWithRoutes([specific, catchAll])

    const res = await app.fetch(new Request('http://localhost/pages/known'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('specific page: known')
  })

  it('page route: a 404 from the specific match cascades into the catch-all page — status 200, not stuck at 404', async () => {
    const specific = pageRoute(
      '/pages/:slug',
      ['slug'],
      defineRoute({
        reads: [],
        render: (ctx: any, request: any) => {
          if (request.params.slug !== 'known') {
            ctx.response.status = 404
            return html`<!doctype html>
              <html>
                <body>specific page: not found</body>
              </html>`
          }
          return html`<!doctype html>
            <html>
              <body>specific page: known</body>
            </html>`
        },
      }),
    )
    const catchAll = pageRoute(
      '/pages/*rest',
      ['rest'],
      defineRoute({
        reads: [],
        render: () => html`<!doctype html>
          <html>
            <body>catch-all page</body>
          </html>`,
      }),
    )
    const app = await appWithRoutes([specific, catchAll])

    const res = await app.fetch(new Request('http://localhost/pages/unknown-slug'))
    // The regression this whole feature is named after: without isolating
    // side effects per candidate, applyRenderedEffects only calls
    // c.status(...) for a non-200 status, so a losing 404 candidate ahead of
    // a winning 200 one would leave the final response's status stuck at
    // 404 even though 200-page content actually went out.
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('catch-all page')
  })

  it('a path matching no route at all still 404s normally (no candidates to cascade through)', async () => {
    const app = await appWithRoutes([])
    const res = await app.fetch(new Request('http://localhost/nothing-matches-this'))
    expect(res.status).toBe(404)
  })
})

describe('the 404 convention (a 404.stator/404.ts file) composes with cascading', () => {
  it('a real [...name] catch-all that 404s cascades into the 404-fallback route, which is only ever tried last', async () => {
    // A real, ordinary catch-all a user wrote themselves — it gets first
    // crack at anything the specific route above it didn't claim.
    const userCatchAll = dataRoute(
      '/blog/*slug',
      ['slug'],
      defineApiRoute({
        method: 'GET',
        handler: (request) =>
          request.params.slug === 'archive'
            ? new Response('user catch-all: archive index', { status: 200 })
            : new Response('user catch-all: nothing here either', { status: 404 }),
      }),
    )
    // The 404.stator/404.ts convention route — isNotFoundFallback forces it
    // below the user's own catch-all above, even though nothing about its
    // urlPath alone would guarantee that ordering.
    const notFoundFallback = dataRoute(
      '/blog/*__stator_notfound__',
      ['__stator_notfound__'],
      defineApiRoute({
        method: 'GET',
        handler: () => new Response('the actual 404 page', { status: 404 }),
      }),
      true,
    )
    const app = await appWithRoutes([notFoundFallback, userCatchAll])

    // The user's catch-all can still fully serve a request on its own —
    // the 404 fallback never even runs.
    const hit = await app.fetch(new Request('http://localhost/blog/archive'))
    expect(hit.status).toBe(200)
    expect(await hit.text()).toBe('user catch-all: archive index')

    // Only once the user's own catch-all ALSO 404s does it cascade past it
    // into the 404-fallback route.
    const miss = await app.fetch(new Request('http://localhost/blog/no-such-post'))
    expect(miss.status).toBe(404)
    expect(await miss.text()).toBe('the actual 404 page')
  })
})
