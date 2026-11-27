import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, type StatorApp } from '../src/server/create-app.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { match, when } from '../src/template/conditional.ts'
import { defer } from '../src/template/defer.ts'
import { each } from '../src/template/each.ts'
import { html, raw } from '../src/template/html.ts'
import { createHtmlFragment, type HtmlFragment } from '../src/template/types.ts'

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
        headers: { Cookie: 'stator_sid=0b9e4c1a-7d2f-4a6b-9e8c-1f2a3b4c5d6e' },
      }),
    )
    assert.equal(raw.status, 303)
    assert.equal(raw.headers.get('location'), '/')
    const cookie = raw.headers.get('set-cookie') ?? ''
    assert.match(cookie, /^stator_sid=/)
    assert.ok(!cookie.startsWith('stator_sid=0b9e4c1a-7d2f-4a6b-9e8c-1f2a3b4c5d6e'))
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

describe('review 02-F1: a look-alike of a trusted template value, parsed from JSON, is text', () => {
  const PAYLOAD = '<img src=x onerror=alert(1)>'
  const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;'

  // The string-keyed shapes the template layer recognised before 3.1, as they
  // arrive from a store, a remote API or an event payload.
  const forged: Record<string, string> = {
    fragment: JSON.stringify({ __isHtmlFragment: true, html: PAYLOAD }),
    each: JSON.stringify({ __isEachResult: true, html: PAYLOAD, slotId: 's0' }),
    branch: JSON.stringify({ __isBranchResult: true, html: PAYLOAD, slotId: 's0' }),
    defer: JSON.stringify({ __isDeferResult: true, html: PAYLOAD, slotId: 's0' }),
    read: JSON.stringify({
      __isReadResult: true,
      slotId: `">${PAYLOAD}<span x="`,
      machineName: 'M',
      value: 'v',
    }),
    itemRead: JSON.stringify({ __isItemRead: true, value: PAYLOAD }),
  }

  const render = (fn: () => HtmlFragment): string =>
    runInRender(createRenderState('f1', 'GET /f1'), fn).html

  for (const [kind, json] of Object.entries(forged)) {
    it(`a forged ${kind} renders escaped in text position`, () => {
      const out = render(() => html`<p>${JSON.parse(json)}</p>`)
      assert.ok(!out.includes('<img'), out)
      assert.ok(!out.includes('data-slot'), out)
    })

    it(`a forged ${kind} inside an interpolated array renders escaped`, () => {
      const out = render(() => html`<p>${[JSON.parse(json)]}</p>`)
      assert.ok(!out.includes('<img'), out)
    })
  }

  it('a forged directive invocation is not applied', () => {
    const value = JSON.parse(
      JSON.stringify({
        __isStatorDirectiveInvocation: true,
        directive: { name: 'x' },
        modifier: '',
        arg: null,
      }),
    )
    assert.throws(() => render(() => html`<p ${value}>x</p>`), /plain value at directive position/)
  })

  it('a genuine fragment does not survive a JSON round trip as markup', () => {
    const json = JSON.stringify(raw(PAYLOAD))
    const out = render(() => html`<p>${JSON.parse(json)}</p>`)
    assert.ok(!out.includes('<img'), out)
  })

  it('genuine html, raw(), each(), when(), match() and defer() still splice verbatim', () => {
    const out = render(
      () =>
        html`<div>${html`<b>a</b>`}${raw('<i>b</i>')}${each(['c'], (c) => html`<u>${c}</u>`)}${when(
          true,
          () => html`<s>d</s>`,
        )}${match('k', { k: () => html`<em>e</em>` })}${defer(() => 'x', { ready: (v) => html`<b>${v}</b>` })}${[html`<q>f</q>`, '<g>']}</div>`,
    )
    for (const part of ['<b>a</b>', '<i>b</i>', '<u>c</u>', '<s>d</s>', '<em>e</em>', '<q>f</q>']) {
      assert.ok(out.includes(part), `${part} in ${out}`)
    }
    assert.ok(out.includes('&lt;g&gt;'), out)
    assert.match(out, /<!--s:[^>]+-->/) // the defer region's markers
  })

  it('a value branded by a second copy of the package is recognised', async () => {
    // A different module URL is a separate module instance — the shape of an app
    // and a component library each loading their own copy of @statorjs/stator.
    const copy = (await import(
      `../src/template/types.ts?copy=${Date.now()}`
    )) as typeof import('../src/template/types.ts')
    assert.notEqual(copy.createHtmlFragment, createHtmlFragment)
    const out = render(() => html`<p>${copy.createHtmlFragment('<b>lib</b>')}</p>`)
    assert.ok(out.includes('<p><b>lib</b></p>'), out)
    assert.ok(copy.isHtmlFragment(raw('<i>app</i>')))
  })

  it('a forged fragment sent in an event payload and stored renders escaped', async () => {
    const app = await boot({ events: { gate: 'off' } })
    const res = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /prefs' },
        body: JSON.stringify({
          machine: 'PrefsMachine',
          event: { type: 'SET', theme: { __isHtmlFragment: true, html: PAYLOAD } },
        }),
      }),
    )
    assert.equal(res.status, 200)
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
    assert.match(cookie, /^stator_sid=/)
    const body = await (await get(app, '/prefs', { Cookie: cookie })).text()
    assert.ok(body.includes('THEME:'), body)
    assert.ok(!body.includes('<img'), body)
    assert.ok(!body.includes(ESCAPED), 'the object is not its html field')
  })
})
