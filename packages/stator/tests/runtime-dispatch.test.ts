// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { init } from '../src/client/runtime.ts'

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
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('delegated dispatch (data-event-* → /__events)', () => {
  it('POSTs the descriptor and marks the element pending until the response applies', async () => {
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    const d = deferred<Response>()
    const spy = vi.fn(() => d.promise)
    vi.stubGlobal('fetch', spy)

    const btn = document.querySelector('button')!
    btn.click()

    expect(btn.hasAttribute('data-stator-pending')).toBe(true)
    const [url, reqInit] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/__events')
    const body = JSON.parse(reqInit.body as string)
    expect(body).toMatchObject({ machine: 'CartMachine', event: { type: 'ADD' } })
    expect(typeof body.eventId).toBe('string')

    d.resolve(Response.json({ patches: [] }))
    await flush()
    expect(btn.hasAttribute('data-stator-pending')).toBe(false)
  })

  it('keeps the pending attribute until the LAST concurrent dispatch settles', async () => {
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    const d1 = deferred<Response>()
    const d2 = deferred<Response>()
    const spy = vi
      .fn()
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise)
    vi.stubGlobal('fetch', spy)

    const btn = document.querySelector('button')!
    btn.click()
    btn.click()
    expect(btn.hasAttribute('data-stator-pending')).toBe(true)

    d1.resolve(Response.json({ patches: [] }))
    await flush()
    expect(btn.hasAttribute('data-stator-pending')).toBe(true)

    d2.resolve(Response.json({ patches: [] }))
    await flush()
    expect(btn.hasAttribute('data-stator-pending')).toBe(false)
  })

  it('exhausts retries on network failure, then clears pending and emits one dispatch-error', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    const spy = vi.fn(async () => {
      throw new TypeError('network down')
    })
    vi.stubGlobal('fetch', spy)
    const errors = listen('stator:dispatch-error')

    const btn = document.querySelector('button')!
    btn.click()
    await vi.advanceTimersByTimeAsync(1_300)

    expect(spy).toHaveBeenCalledTimes(3)
    expect(btn.hasAttribute('data-stator-pending')).toBe(false)
    expect(errors).toMatchObject([{ machine: 'CartMachine', phase: 'network' }])
  })

  it('retries with backoff reusing the same eventId, and succeeds silently', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    const d = deferred<Response>()
    const spy = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('down'))
      .mockRejectedValueOnce(new TypeError('down'))
      .mockImplementationOnce(() => d.promise)
    vi.stubGlobal('fetch', spy)
    const errors = listen('stator:dispatch-error')

    const btn = document.querySelector('button')!
    btn.click()
    await vi.advanceTimersByTimeAsync(300)
    expect(spy).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(spy).toHaveBeenCalledTimes(3)

    const ids = spy.mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string).eventId as string,
    )
    expect(ids[0]).toBeTruthy()
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).toBe(ids[0])

    d.resolve(Response.json({ patches: [] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toEqual([])
    expect(btn.hasAttribute('data-stator-pending')).toBe(false)
  })

  it('emits phase http with the status on a non-2xx response, without retrying', async () => {
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    const spy = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', spy)
    const errors = listen('stator:dispatch-error')

    document.querySelector('button')!.click()
    await flush()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(errors).toMatchObject([{ machine: 'CartMachine', phase: 'http', status: 500 }])
  })

  it('aborts a hung POST at the deadline and emits phase timeout', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `<button data-event-click='${DESCRIPTOR}'>go</button>`
    init()
    vi.stubGlobal(
      'fetch',
      vi.fn(
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
    expect(btn.hasAttribute('data-stator-pending')).toBe(true)

    // Three attempts each hit the 10s deadline, with 300ms/1000ms backoff
    // between them — 35s of fake time covers the full ladder.
    await vi.advanceTimersByTimeAsync(35_000)
    expect(errors).toMatchObject([{ machine: 'CartMachine', phase: 'timeout' }])
    expect(btn.hasAttribute('data-stator-pending')).toBe(false)
  })
})

describe('enhanced form submit (data-stator-enhance)', () => {
  it('marks the form pending and emits a machine-less dispatch-error on failure', async () => {
    document.body.innerHTML = `<form data-stator-enhance action="/submit" method="post"><input name="a" value="1"></form>`
    init()
    const d = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => d.promise),
    )
    const errors = listen('stator:dispatch-error')

    const form = document.querySelector('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    expect(form.hasAttribute('data-stator-pending')).toBe(true)
    d.resolve(new Response('nope', { status: 422 }))
    await flush()

    expect(form.hasAttribute('data-stator-pending')).toBe(false)
    expect(errors).toMatchObject([{ phase: 'http', status: 422 }])
    expect((errors[0] as { machine?: string }).machine).toBeUndefined()
  })
})
