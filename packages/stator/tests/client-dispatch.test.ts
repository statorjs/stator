// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatch } from '../src/client/dispatch.ts'
import type { AnyMachineDef } from '../src/engine/index.ts'

/** The identity stub a browser bundle sees for a server-machine import
 *  (see vite/stub.ts) — dispatch only reads `.name`. */
const Cart = { name: 'CartMachine' } as AnyMachineDef

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(response: () => Promise<Response>) {
  const spy = vi.fn(response)
  vi.stubGlobal('fetch', spy)
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
    expect(result.ok).toBe(true)
    expect(result.committed).toBe(true)

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/__events')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Stator-Route']).toMatch(/^GET /)
    expect(JSON.parse(init.body as string)).toEqual({
      machine: 'CartMachine',
      event: { type: 'ADD', productId: 'p1' },
    })
    expect(document.querySelector('[data-slot="s0"]')!.textContent).toBe('new')
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
    expect(seen).toEqual([{ x: 1 }])
  })

  it('returns false on HTTP errors without throwing', async () => {
    stubFetch(async () => new Response('nope', { status: 500 }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await dispatch(Cart, { type: 'ADD' } as never)).toMatchObject({
        ok: false,
        committed: false,
      })
    } finally {
      errSpy.mockRestore()
    }
  })

  it('returns false on network failures without throwing', async () => {
    stubFetch(async () => {
      throw new TypeError('network down')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await dispatch(Cart, { type: 'ADD' } as never)).toMatchObject({
        ok: false,
        committed: false,
      })
    } finally {
      errSpy.mockRestore()
    }
  })
})
