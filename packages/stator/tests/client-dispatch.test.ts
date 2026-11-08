// @env happy-dom
import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { dispatch } from '../src/client/dispatch.ts'
import type { AnyMachineDef } from '../src/engine/index.ts'
import { stubGlobal, unstubAllGlobals } from './helpers/mocks.ts'

/** The identity stub a browser bundle sees for a server-machine import
 *  (see vite/stub.ts) — dispatch only reads `.name`. */
const Cart = { name: 'CartMachine' } as AnyMachineDef

afterEach(() => {
  unstubAllGlobals()
})

function stubFetch(response: () => Promise<Response>) {
  const spy = mock.fn(response)
  stubGlobal('fetch', spy)
  return spy
}

describe('client dispatch (island → server wire)', () => {
  it('POSTs the machine name + event to /__events and applies returned patches', async () => {
    document.body.innerHTML = '<span data-slot="s0">old</span>'
    const spy = stubFetch(async () =>
      Response.json({
        patches: [{ target: { kind: 'slot', id: 's0' }, op: 'text', value: 'new' }],
      }),
    )

    const result = await dispatch(Cart, { type: 'ADD', productId: 'p1' } as never)
    assert.equal(result.ok, true)
    assert.equal(result.committed, true)

    const [url, init] = spy.mock.calls[0]!.arguments as unknown as [string, RequestInit]
    assert.equal(url, '/__events')
    assert.equal(init.method, 'POST')
    assert.match((init.headers as Record<string, string>)['X-Stator-Route'] ?? '', /^GET /)
    const body = JSON.parse(init.body as string)
    assert.partialDeepStrictEqual(body, {
      machine: 'CartMachine',
      event: { type: 'ADD', productId: 'p1' },
    })
    assert.equal(typeof body.eventId, 'string')
    assert.equal(document.querySelector('[data-slot="s0"]')!.textContent, 'new')
  })

  it('applies directives from the response envelope', async () => {
    stubFetch(async () =>
      Response.json({
        patches: [],
        directives: [{ type: 'event', name: 'custom:done', detail: { x: 1 } }],
      }),
    )
    const seen: unknown[] = []
    window.addEventListener('custom:done', (e) => seen.push((e as CustomEvent).detail))

    await dispatch(Cart, { type: 'ADD' } as never)
    assert.deepStrictEqual(seen, [{ x: 1 }])
  })

  it('returns false on HTTP errors without throwing', async () => {
    stubFetch(async () => new Response('nope', { status: 500 }))
    const errSpy = mock.method(console, 'error', () => {})
    try {
      assert.partialDeepStrictEqual(await dispatch(Cart, { type: 'ADD' } as never), {
        ok: false,
        committed: false,
        error: { phase: 'http', status: 500 },
      })
    } finally {
      errSpy.mock.restore()
    }
  })

  it('returns false on network failures without throwing', async () => {
    stubFetch(async () => {
      throw new TypeError('network down')
    })
    const errSpy = mock.method(console, 'error', () => {})
    try {
      assert.partialDeepStrictEqual(await dispatch(Cart, { type: 'ADD' } as never), {
        ok: false,
        committed: false,
        error: { phase: 'network' },
      })
    } finally {
      errSpy.mock.restore()
    }
  })
})
