import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, type StatorApp } from '../src/server/create-app.ts'
import Orders from './fixtures/route-admission/machines/orders.ts'

/**
 * `/__events` and `/__sse` act on a page they name out of band (a header, a
 * query parameter), so a middleware guard written against the request path
 * never sees that page's path on them. The framework asks the middleware
 * whether it would admit the caller to the page itself before either endpoint
 * renders it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/route-admission')

const boot = (middleware = true): Promise<StatorApp> =>
  createApp({
    machinesDir: resolve(root, 'machines'),
    routesDir: resolve(root, 'routes'),
    ...(middleware ? { middlewareFile: resolve(root, 'middleware.ts') } : {}),
  })

const event = (app: StatorApp, route: string, cookie = '') =>
  Promise.resolve(
    app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Stator-Route': route, Cookie: cookie },
        body: JSON.stringify({ machine: 'PrefsMachine', event: { type: 'SET', theme: 'dark' } }),
      }),
    ),
  )

const sse = (app: StatorApp, route: string, cookie = '', signal?: AbortSignal) =>
  Promise.resolve(
    app.fetch(
      new Request(`http://localhost/__sse?route=${encodeURIComponent(route)}`, {
        headers: { Cookie: cookie },
        signal,
      }),
    ),
  )

/** Read an SSE body until `done` holds or 3 s pass, then end it. */
async function readUntil(res: Response, abort: AbortController, done: (t: string) => boolean) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 3000
  try {
    while (!done(text) && Date.now() < deadline) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    abort.abort()
    // Cancelling the body is what ends the stream on the server: aborting an
    // in-process request alone leaves its keep-alive timer running.
    await reader.cancel().catch(() => {})
  }
  return text
}

describe('route admission: the page GET', () => {
  it('is gated by the path guard', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/admin/orders'))
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/login')
  })

  it('is served to an admitted caller', async () => {
    const app = await boot()
    const res = await app.fetch(
      new Request('http://localhost/admin/orders', { headers: { Cookie: 'role=admin' } }),
    )
    assert.equal(res.status, 200)
    assert.match(await res.text(), /Ada Lovelace/)
  })
})

describe('route admission: /__sse', () => {
  it('refuses a caller the middleware would turn away from the page', async () => {
    const app = await boot()
    const res = await sse(app, 'GET /admin/orders')
    assert.equal(res.status, 403)
    assert.ok(!(await res.text()).includes('Ada Lovelace'))
  })

  it('passes the middleware’s own refusal status through', async () => {
    const app = await boot()
    assert.equal((await sse(app, 'GET /admin/orders', 'role=banned')).status, 403)
  })

  it('streams to an admitted caller, later changes included', async () => {
    const app = await boot()
    const abort = new AbortController()
    const res = await sse(app, 'GET /admin/orders', 'role=admin', abort.signal)
    assert.equal(res.status, 200)
    setTimeout(() => {
      void app.dispatchToApp(Orders, { type: 'ADD', note: 'order 1002: Grace Hopper' })
    }, 100)
    const text = await readUntil(res, abort, (t) => t.includes('order 1002'))
    assert.ok(text.includes('order 1002'))
  })
})

describe('route admission: /__events', () => {
  it('sends a redirected caller where the page would, keeping the middleware’s cookie', async () => {
    const app = await boot()
    const res = await event(app, 'GET /admin/orders')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
      patches: [],
      directives: [{ type: 'navigate', to: '/login' }],
      committed: false,
    })
    assert.ok(res.headers.getSetCookie().some((c) => c.startsWith('returnTo=')))
  })

  it('refuses a caller the middleware refuses, and runs no event', async () => {
    const app = await boot()
    const sid = crypto.randomUUID()
    const res = await event(app, 'GET /admin/orders', `stator_sid=${sid}; role=banned`)
    assert.equal(res.status, 403)
    assert.ok(!(await app.store.persistence.get(sid, 'PrefsMachine')))
  })

  it('runs the event for an admitted caller', async () => {
    const app = await boot()
    const res = await event(app, 'GET /admin/orders', 'role=admin')
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { committed: boolean }).committed, true)
  })

  it('leaves an ungated page alone', async () => {
    const app = await boot()
    const res = await event(app, 'GET /')
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { committed: boolean }).committed, true)
  })

  it('carries the page’s query to the guard', async () => {
    const app = await boot()
    const res = await event(app, 'GET /admin/orders?tab=open')
    assert.deepEqual(((await res.json()) as { directives: unknown[] }).directives, [
      { type: 'navigate', to: '/login' },
    ])
  })
})

describe('route admission: an app with no middleware', () => {
  it('asks nothing', async () => {
    const app = await boot(false)
    assert.equal((await event(app, 'GET /admin/orders')).status, 200)
  })
})
