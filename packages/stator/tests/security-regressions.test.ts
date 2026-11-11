import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, type StatorApp } from '../src/server/create-app.ts'

/**
 * Regressions from the 3.0 security audit (`.chisel/docs/security-audit-3.0.md`).
 * Each case is the audit's own proof, turned around: it failed the fix's
 * absence and passes now.
 */

const here = dirname(fileURLToPath(import.meta.url))
const probe = resolve(here, 'fixtures/audit-probe')

const boot = (extra: Record<string, unknown> = {}): Promise<StatorApp> =>
  createApp({
    machinesDir: resolve(probe, 'machines'),
    routesDir: resolve(probe, 'routes'),
    middlewareFile: resolve(probe, 'middleware.ts'),
    ...extra,
  })

const get = async (app: StatorApp, path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://localhost${path}`, { headers }))

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

describe('audit #4: `$` in text rendered inside a defer arm', () => {
  const review = async (app: StatorApp, text: string) =>
    (await get(app, `/review?text=${encodeURIComponent(text)}`)).text()

  it('is text, not a replacement pattern', async () => {
    const app = await boot()
    for (const text of ['$`', "$'", 'a $& b', '$$', '$1']) {
      const body = await review(app, text)
      assert.equal(count(body, 'HEADING'), 1, text)
      assert.equal(count(body, 'FOOTER'), 1, text)
      assert.ok(!body.includes('<!--defer:'), text)
    }
    assert.ok((await review(app, 'cost: $& more')).includes('cost: $&amp; more'))
  })

  it('does not multiply the response', async () => {
    const app = await boot()
    const plain = await review(app, 'x')
    const body = await review(app, '$`'.repeat(1000))
    assert.equal(count(body, 'HEADING'), 1)
    assert.ok(body.length < plain.length + 3000)
  })
})

describe('audit #3: derived Cache-Control and Set-Cookie', () => {
  it('marks an anonymous page public when nothing sets a cookie', async () => {
    const res = await get(await boot(), '/landing')
    assert.match(res.headers.get('cache-control') ?? '', /^public, .*s-maxage=60/)
    assert.equal(res.headers.get('set-cookie'), null)
  })

  it('withdraws it when middleware sets a cookie on the response', async () => {
    const res = await get(await boot(), '/landing', { 'x-poc-bucket': '1' })
    assert.match(res.headers.get('set-cookie') ?? '', /^bucket=/)
    assert.equal(res.headers.get('cache-control'), null)
    assert.match(await res.text(), /landing/)
  })
})

describe('audit #7: a raw Response keeps what the context gathered', () => {
  it('securityHeaders() covers a raw-Response data route, whose own headers win', async () => {
    const app = await boot()
    const data = await get(app, '/export.csv')
    assert.equal(data.status, 200)
    assert.equal(data.headers.get('x-content-type-options'), 'nosniff')
    assert.ok(data.headers.get('x-frame-options'))
    assert.equal(data.headers.get('content-type'), 'text/csv')
    assert.equal(await data.text(), 'a,b\n1,2\n')
  })

  it('rotateSession() followed by a raw redirect sends the new session cookie', async () => {
    const app = await boot()
    const raw = await app.fetch(
      new Request('http://localhost/login?raw=1', {
        method: 'POST',
        headers: { Cookie: 'stator_sid=old-session-id' },
      }),
    )
    assert.equal(raw.status, 303)
    assert.equal(raw.headers.get('location'), '/')
    const cookie = raw.headers.get('set-cookie') ?? ''
    assert.match(cookie, /^stator_sid=/)
    assert.ok(!cookie.startsWith('stator_sid=old-session-id'))
  })
})

describe('audit #6: the /__events body cap', () => {
  const post = (app: StatorApp, body: string, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /landing',
          ...headers,
        },
        body,
      }),
    )
  const event = (theme: string) =>
    JSON.stringify({ machine: 'PrefsMachine', event: { type: 'SET', theme } })

  it('refuses a body past the cap and stores nothing', async () => {
    const app = await boot({ events: { gate: 'off' } })
    const res = await post(app, event('x'.repeat(200_000)), { Cookie: 'stator_sid=big-body' })
    assert.equal(res.status, 413)
    assert.ok(!(await app.store.persistence.get('big-body', 'PrefsMachine')))
  })

  it('counts the bytes that arrive, not the length the request declares', async () => {
    const app = await boot({ events: { gate: 'off' } })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event('x'.repeat(200_000))))
        controller.close()
      },
    })
    const res = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /landing' },
        body,
        duplex: 'half',
      } as RequestInit),
    )
    assert.equal(res.status, 413)
  })

  it('accepts an ordinary event, and a larger one when the cap is raised', async () => {
    const small = await boot({ events: { gate: 'off' } })
    assert.equal((await post(small, event('dark'))).status, 200)
    const roomy = await boot({ events: { gate: 'off', maxBytes: 500_000 } })
    assert.equal((await post(roomy, event('x'.repeat(200_000)))).status, 200)
  })
})

describe('audit #5: the anonymous placeholder is not a lock a client can hold', () => {
  it('a cookieless data GET does not wait behind a request claiming the placeholder id', async () => {
    const app = await boot()
    const timed = async (): Promise<number> => {
      const start = performance.now()
      assert.equal((await get(app, '/export.csv')).status, 200)
      return performance.now() - start
    }
    await timed()
    const slow = app.fetch(
      new Request('http://localhost/slow', {
        method: 'POST',
        headers: { Cookie: 'stator_sid=@anonymous' },
      }),
    )
    await new Promise((r) => setTimeout(r, 20))
    const waited = await timed()
    await slow
    assert.ok(waited < 200, `the anonymous visitor waited ${Math.round(waited)}ms`)
  })

  it('a cookie naming a framework scope is not a session', async () => {
    const app = await boot({ events: { gate: 'off' } })
    for (const sid of ['@anonymous', '@app']) {
      const res = await app.fetch(
        new Request('http://localhost/__events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Stator-Route': 'GET /landing',
            Cookie: `stator_sid=${sid}`,
          },
          body: JSON.stringify({ machine: 'PrefsMachine', event: { type: 'SET', theme: 'dark' } }),
        }),
      )
      assert.equal(res.status, 200)
      // A fresh id is issued, and nothing is stored under the claimed one.
      assert.match(res.headers.get('set-cookie') ?? '', /^stator_sid=(?!@)/)
      assert.ok(!(await app.store.persistence.get(sid, 'PrefsMachine')), sid)
    }
  })
})
