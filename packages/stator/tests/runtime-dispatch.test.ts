// @env happy-dom
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { init } from '../src/client/runtime.ts'
import { advanceTimersAsync, stubGlobal, unstubAllGlobals, useFakeTimers } from './helpers/mocks.ts'

const DESCRIPTOR = '{"machine":"CartMachine","event":{"type":"ADD"}}'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Collect a `stator:*` event's details; listener removed in afterEach. */
const cleanups: Array<() => void> = []
function listen(name: string): unknown[] {
  const seen: unknown[] = []
  const fn = (e: Event) => seen.push((e as CustomEvent).detail)
  window.addEventListener(name, fn)
  cleanups.push(() => window.removeEventListener(name, fn))
  return seen
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  mock.method(console, 'error', () => {})
  mock.method(console, 'warn', () => {})
})

afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  unstubAllGlobals()
  mock.timers.reset()
  mock.restoreAll()
  document.body.innerHTML = ''
})

describe('delegated dispatch (data-event-* → /__events)', () => {
  it('POSTs the descriptor and marks the element pending until the response applies', async () => {
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    const d = deferred<Response>()
    const spy = mock.fn(() => d.promise)
    stubGlobal('fetch', spy)

    const btn = document.querySelector('button')!
    btn.click()

    assert.equal(btn.hasAttribute('data-stator-pending'), true)
    const [url, reqInit] = spy.mock.calls[0]!.arguments as unknown as [string, RequestInit]
    assert.equal(url, '/__events')
    const body = JSON.parse(reqInit.body as string)
    assert.partialDeepStrictEqual(body, { machine: 'CartMachine', event: { type: 'ADD' } })
    assert.equal(typeof body.eventId, 'string')

    d.resolve(Response.json({ patches: [] }))
    await flush()
    assert.equal(btn.hasAttribute('data-stator-pending'), false)
  })

  it('delivers a double-click bound with on:dblclick', async () => {
    document.body.innerHTML = `<label data-event-dblclick='${DESCRIPTOR}'>edit</label>`
    init()
    const spy = mock.fn(async () => Response.json({ patches: [] }))
    stubGlobal('fetch', spy)

    document.querySelector('label')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flush()

    assert.equal(spy.mock.calls.length, 1)
    const [, reqInit] = spy.mock.calls[0]!.arguments as unknown as [string, RequestInit]
    assert.partialDeepStrictEqual(JSON.parse(reqInit.body as string), { machine: 'CartMachine' })
  })

  it('keeps the pending attribute until the LAST concurrent dispatch settles', async () => {
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    const d1 = deferred<Response>()
    const d2 = deferred<Response>()
    const spy = mock.fn<() => Promise<Response>>()
    spy.mock.mockImplementationOnce(() => d1.promise, 0)
    spy.mock.mockImplementationOnce(() => d2.promise, 1)
    stubGlobal('fetch', spy)

    const btn = document.querySelector('button')!
    btn.click()
    btn.click()
    assert.equal(btn.hasAttribute('data-stator-pending'), true)

    d1.resolve(Response.json({ patches: [] }))
    await flush()
    assert.equal(btn.hasAttribute('data-stator-pending'), true)

    d2.resolve(Response.json({ patches: [] }))
    await flush()
    assert.equal(btn.hasAttribute('data-stator-pending'), false)
  })

  it('exhausts retries on network failure, then clears pending and emits one dispatch-error', async () => {
    useFakeTimers()
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    const spy = mock.fn(async () => {
      throw new TypeError('network down')
    })
    stubGlobal('fetch', spy)
    const errors = listen('stator:dispatch-error')

    const btn = document.querySelector('button')!
    btn.click()
    await advanceTimersAsync(1_300)

    assert.equal(spy.mock.callCount(), 3)
    assert.equal(btn.hasAttribute('data-stator-pending'), false)
    assert.partialDeepStrictEqual(errors, [{ machine: 'CartMachine', phase: 'network' }])
  })

  it('retries with backoff reusing the same eventId, and succeeds silently', async () => {
    useFakeTimers()
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    const d = deferred<Response>()
    const spy = mock.fn<() => Promise<Response>>()
    spy.mock.mockImplementationOnce(() => Promise.reject(new TypeError('down')), 0)
    spy.mock.mockImplementationOnce(() => Promise.reject(new TypeError('down')), 1)
    spy.mock.mockImplementationOnce(() => d.promise, 2)
    stubGlobal('fetch', spy)
    const errors = listen('stator:dispatch-error')

    const btn = document.querySelector('button')!
    btn.click()
    await advanceTimersAsync(300)
    assert.equal(spy.mock.callCount(), 2)
    await advanceTimersAsync(1_000)
    assert.equal(spy.mock.callCount(), 3)

    const ids = spy.mock.calls.map(
      (c) =>
        JSON.parse(((c.arguments as unknown[])[1] as RequestInit).body as string).eventId as string,
    )
    assert.ok(ids[0])
    assert.equal(ids[1], ids[0])
    assert.equal(ids[2], ids[0])

    d.resolve(Response.json({ patches: [] }))
    await advanceTimersAsync(0)
    assert.deepStrictEqual(errors, [])
    assert.equal(btn.hasAttribute('data-stator-pending'), false)
  })

  it('emits phase http with the status on a non-2xx response, without retrying', async () => {
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    const spy = mock.fn(async () => new Response('boom', { status: 500 }))
    stubGlobal('fetch', spy)
    const errors = listen('stator:dispatch-error')

    document.querySelector('button')!.click()
    await flush()

    assert.equal(spy.mock.callCount(), 1)
    assert.partialDeepStrictEqual(errors, [{ machine: 'CartMachine', phase: 'http', status: 500 }])
  })

  it('puts the server error string on the dispatch-error detail, without retrying a 4xx', async () => {
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    const spy = mock.fn(async () =>
      Response.json({ error: 'event type "ADD" is server-only' }, { status: 403 }),
    )
    stubGlobal('fetch', spy)
    const errors = listen('stator:dispatch-error')

    const btn = document.querySelector('button')!
    btn.click()
    await flush()

    assert.equal(spy.mock.callCount(), 1)
    assert.equal(btn.hasAttribute('data-stator-pending'), false)
    assert.partialDeepStrictEqual(errors, [
      {
        machine: 'CartMachine',
        phase: 'http',
        status: 403,
        message: 'event type "ADD" is server-only',
      },
    ])
  })

  it('reports a 200 with a malformed body as a dispatch-error', async () => {
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    stubGlobal(
      'fetch',
      mock.fn(async () => new Response('not json', { status: 200 })),
    )
    const errors = listen('stator:dispatch-error')

    const btn = document.querySelector('button')!
    btn.click()
    await flush()

    assert.partialDeepStrictEqual(errors, [
      { machine: 'CartMachine', phase: 'http', status: 200, message: 'malformed response body' },
    ])
    assert.equal(btn.hasAttribute('data-stator-pending'), false)
  })

  it('applies a 422 refusal envelope and fires no dispatch-error', async () => {
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    stubGlobal(
      'fetch',
      mock.fn(async () =>
        Response.json(
          { patches: [], committed: false, refusal: { code: 'full' } },
          { status: 422 },
        ),
      ),
    )
    const errors = listen('stator:dispatch-error')
    const received = listen('stator:patches-received')

    const btn = document.querySelector('button')!
    btn.click()
    await flush()

    assert.deepStrictEqual(errors, [])
    assert.partialDeepStrictEqual(received, [{ patches: [], source: 'post' }])
    assert.equal(btn.hasAttribute('data-stator-pending'), false)
  })

  it('aborts a hung POST at the deadline and emits phase timeout', async () => {
    useFakeTimers()
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    stubGlobal(
      'fetch',
      mock.fn(
        (_url: string, reqInit: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            reqInit.signal?.addEventListener('abort', () => {
              const e = new Error('aborted')
              e.name = 'AbortError'
              rej(e)
            })
          }),
      ),
    )
    const errors = listen('stator:dispatch-error')

    const btn = document.querySelector('button')!
    btn.click()
    assert.equal(btn.hasAttribute('data-stator-pending'), true)

    // Three attempts each hit the 10s deadline, with 300ms/1000ms backoff
    // between them — 35s of fake time covers the full ladder.
    await advanceTimersAsync(35_000)
    assert.partialDeepStrictEqual(errors, [{ machine: 'CartMachine', phase: 'timeout' }])
    assert.equal(btn.hasAttribute('data-stator-pending'), false)
  })
})

describe('a throwing patch on a template send', () => {
  it('applies the rest of the batch and the directives, fires one patch-error, and clears pending', async () => {
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button><span data-slot="s0">a</span><span data-slot="s1">b</span><span data-slot="s2">c</span>`
    Object.defineProperty(document.querySelector('[data-slot="s1"]')!, 'textContent', {
      set() {
        throw new Error('boom')
      },
    })
    init()
    stubGlobal(
      'fetch',
      mock.fn(async () =>
        Response.json({
          patches: [
            { target: { kind: 'slot', id: 's0' }, op: 'text', value: 'A' },
            { target: { kind: 'slot', id: 's1' }, op: 'text', value: 'B' },
            { target: { kind: 'slot', id: 's2' }, op: 'text', value: 'C' },
          ],
          directives: [{ type: 'event', name: 'custom:after', detail: 1 }],
        }),
      ),
    )
    const patchErrors = listen('stator:patch-error')
    const after = listen('custom:after')
    const sent = listen('stator:event-sent')

    const btn = document.querySelector('button')!
    btn.click()
    await flush()

    assert.equal(document.querySelector('[data-slot="s0"]')!.textContent, 'A')
    assert.equal(document.querySelector('[data-slot="s2"]')!.textContent, 'C')
    assert.equal(patchErrors.length, 1)
    assert.partialDeepStrictEqual(patchErrors, [{ patch: { target: { id: 's1' } } }])
    assert.deepStrictEqual(after, [1])
    assert.equal(sent.length, 1)
    assert.equal(btn.hasAttribute('data-stator-pending'), false)
  })
})

describe('enhanced form submit (data-stator-enhance)', () => {
  it('marks the form pending and emits a machine-less dispatch-error on failure', async () => {
    document.body.innerHTML = `<form data-stator-enhance action="/submit" method="post"><input name="a" value="1"></form>`
    init()
    const d = deferred<Response>()
    stubGlobal(
      'fetch',
      mock.fn(() => d.promise),
    )
    const errors = listen('stator:dispatch-error')

    const form = document.querySelector('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    assert.equal(form.hasAttribute('data-stator-pending'), true)
    d.resolve(new Response('nope', { status: 422 }))
    await flush()

    assert.equal(form.hasAttribute('data-stator-pending'), false)
    assert.partialDeepStrictEqual(errors, [{ phase: 'http', status: 422 }])
    assert.equal((errors[0] as { machine?: string }).machine, undefined)
  })

  it("passes a JSON error body's string through as the dispatch-error message", async () => {
    document.body.innerHTML = `<form data-stator-enhance action="/submit" method="post"><input name="a" value="1"></form>`
    init()
    stubGlobal(
      'fetch',
      mock.fn(async () => Response.json({ error: 'email is required' }, { status: 422 })),
    )
    const errors = listen('stator:dispatch-error')

    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    assert.deepStrictEqual(
      errors.map((e) => {
        const { timestamp: _t, ...rest } = e as { timestamp: number }
        return rest
      }),
      [{ phase: 'http', status: 422, message: 'email is required' }],
    )
  })
})
