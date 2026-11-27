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
    assert.ok((init.headers as Record<string, string>)['X-Stator-Route'])
    assert.match((init.headers as Record<string, string>)['X-Stator-Route']!, /^GET /)
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

  describe('reads the body of every answer', () => {
    function quiet<T>(fn: () => Promise<T>): Promise<T> {
      const errSpy = mock.method(console, 'error', () => {})
      return fn().finally(() => errSpy.mock.restore())
    }
    function listen(name: string): { seen: unknown[]; stop: () => void } {
      const seen: unknown[] = []
      const fn = (e: Event) => seen.push((e as CustomEvent).detail)
      window.addEventListener(name, fn)
      return { seen, stop: () => window.removeEventListener(name, fn) }
    }

    it("a 403 with a JSON error gives the server's sentence as error.message", async () => {
      stubFetch(async () =>
        Response.json({ error: 'event type "CHARGE_OK" is server-only' }, { status: 403 }),
      )
      const errors = listen('stator:dispatch-error')
      try {
        const result = await quiet(() => dispatch(Cart, { type: 'ADD' } as never))
        assert.deepStrictEqual(result, {
          ok: false,
          committed: false,
          patchCount: 0,
          error: { phase: 'http', status: 403, message: 'event type "CHARGE_OK" is server-only' },
        })
        assert.partialDeepStrictEqual(errors.seen, [
          {
            machine: 'CartMachine',
            phase: 'http',
            status: 403,
            message: 'event type "CHARGE_OK" is server-only',
          },
        ])
      } finally {
        errors.stop()
      }
    })

    it('a 413 and a 400 carry their messages; the 400 detail stays out of the result', async () => {
      stubFetch(async () =>
        Response.json({ error: 'event body exceeds 65536 bytes' }, { status: 413 }),
      )
      const big = await quiet(() => dispatch(Cart, { type: 'ADD' } as never))
      assert.deepStrictEqual(big.error, {
        phase: 'http',
        status: 413,
        message: 'event body exceeds 65536 bytes',
      })

      stubFetch(async () =>
        Response.json({ error: 'invalid event payload', detail: 'ZodError: …' }, { status: 400 }),
      )
      const bad = await quiet(() => dispatch(Cart, { type: 'ADD' } as never))
      assert.deepStrictEqual(bad.error, {
        phase: 'http',
        status: 400,
        message: 'invalid event payload',
      })
    })

    it('a 500 with a text body gives no message', async () => {
      stubFetch(async () => new Response('Internal Server Error', { status: 500 }))
      const result = await quiet(() => dispatch(Cart, { type: 'ADD' } as never))
      assert.deepStrictEqual(result.error, { phase: 'http', status: 500 })
    })

    it('a 200 whose body is not JSON resolves ok: false instead of rejecting', async () => {
      stubFetch(async () => new Response('<html>oops</html>', { status: 200 }))
      const errors = listen('stator:dispatch-error')
      try {
        const result = await quiet(() => dispatch(Cart, { type: 'ADD' } as never))
        assert.deepStrictEqual(result, {
          ok: false,
          committed: false,
          patchCount: 0,
          error: { phase: 'http', status: 200, message: 'malformed response body' },
        })
        assert.equal(errors.seen.length, 1)
      } finally {
        errors.stop()
      }
    })

    it('a 200 whose JSON is not an object is malformed too', async () => {
      stubFetch(async () => Response.json([1, 2]))
      const result = await quiet(() => dispatch(Cart, { type: 'ADD' } as never))
      assert.deepStrictEqual(result.error, {
        phase: 'http',
        status: 200,
        message: 'malformed response body',
      })
    })

    it('a 422 carrying a refusal is an answer: ok, not committed, no dispatch-error', async () => {
      const spy = stubFetch(async () =>
        Response.json(
          { patches: [], committed: false, refusal: { code: 'full', message: 'No seats left.' } },
          { status: 422 },
        ),
      )
      const errors = listen('stator:dispatch-error')
      const errSpy = mock.method(console, 'error', () => {})
      try {
        const result = await dispatch(Cart, { type: 'ADD' } as never)
        assert.deepStrictEqual(result, { ok: true, committed: false, patchCount: 0 })
        assert.deepStrictEqual(errors.seen, [])
        assert.equal(errSpy.mock.callCount(), 0)
        assert.equal(spy.mock.callCount(), 1)
      } finally {
        errSpy.mock.restore()
        errors.stop()
      }
    })

    it('a 422 with no refusal object is a failed request', async () => {
      stubFetch(async () => Response.json({ error: 'not admitted to this route' }, { status: 422 }))
      const errors = listen('stator:dispatch-error')
      try {
        const result = await quiet(() => dispatch(Cart, { type: 'ADD' } as never))
        assert.deepStrictEqual(result.error, {
          phase: 'http',
          status: 422,
          message: 'not admitted to this route',
        })
        assert.equal(result.ok, false)
        assert.equal(errors.seen.length, 1)
      } finally {
        errors.stop()
      }
    })

    it('a 422 whose refusal has no string code is a failed request', async () => {
      stubFetch(async () =>
        Response.json({ committed: false, refusal: { code: 7 } }, { status: 422 }),
      )
      const result = await quiet(() => dispatch(Cart, { type: 'ADD' } as never))
      assert.equal(result.ok, false)
      assert.deepStrictEqual(result.error, { phase: 'http', status: 422 })
    })

    it('does not retry a 4xx', async () => {
      const spy = stubFetch(async () => Response.json({ error: 'nope' }, { status: 404 }))
      await quiet(() => dispatch(Cart, { type: 'ADD' } as never))
      assert.equal(spy.mock.callCount(), 1)
    })
  })
})
