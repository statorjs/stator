// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initLiveChannel } from '../src/client/runtime.ts'

/** Test-driven EventSource: the runtime sees the standard surface, tests
 *  drive open/message/error. A closed instance goes inert, matching the
 *  browser (a replaced connection can't keep mutating state). */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  readyState = FakeEventSource.CONNECTING
  private listeners = new Map<string, Set<(e: unknown) => void>>()
  constructor(
    public url: string,
    public opts?: { withCredentials?: boolean },
  ) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(fn)
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }
  private fire(type: string, e: unknown): void {
    if (this.readyState === FakeEventSource.CLOSED) return
    for (const fn of this.listeners.get(type) ?? []) fn(e)
  }
  emitOpen(): void {
    this.readyState = FakeEventSource.OPEN
    this.fire('open', new Event('open'))
  }
  emitMessage(data: unknown): void {
    this.fire('message', { data: JSON.stringify(data) })
  }
  emitError(): void {
    this.fire('error', new Event('error'))
  }
}

const cleanups: Array<() => void> = []
function listen(name: string): unknown[] {
  const seen: unknown[] = []
  const fn = (e: Event) => seen.push((e as CustomEvent).detail)
  window.addEventListener(name, fn)
  cleanups.push(() => window.removeEventListener(name, fn))
  return seen
}

let handle: { close(): void } | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('EventSource', FakeEventSource)
  FakeEventSource.instances = []
  document.head.innerHTML = '<meta name="stator-live" content="true">'
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  handle?.close()
  handle = undefined
  for (const c of cleanups.splice(0)) c()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-stator-connection')
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function connectionAttr(): string | null {
  return document.documentElement.getAttribute('data-stator-connection')
}

describe('live channel (SSE client)', () => {
  it('marks the page connected on open and applies pushed patches', () => {
    document.body.innerHTML = '<span data-slot="s0">old</span>'
    handle = initLiveChannel()
    expect(FakeEventSource.instances).toHaveLength(1)
    const es = FakeEventSource.instances[0]!

    es.emitOpen()
    expect(connectionAttr()).toBe('connected')

    es.emitMessage({ patches: [{ target: { kind: 'slot', id: 's0' }, op: 'text', value: 'new' }] })
    expect(document.querySelector('[data-slot="s0"]')!.textContent).toBe('new')
  })

  it('does nothing on a non-live route', () => {
    document.head.innerHTML = ''
    handle = initLiveChannel()
    expect(handle).toBeUndefined()
    expect(FakeEventSource.instances).toHaveLength(0)
    expect(connectionAttr()).toBeNull()
  })

  it('announces disconnected once across repeated errors (change guard)', () => {
    const states = listen('stator:connection-state')
    handle = initLiveChannel()
    const es = FakeEventSource.instances[0]!

    es.emitOpen()
    es.emitError()
    es.emitError()
    es.emitError()

    expect(connectionAttr()).toBe('disconnected')
    expect(states).toMatchObject([{ state: 'connected' }, { state: 'disconnected' }])
  })

  it('stays on one connection while ping frames arrive', () => {
    handle = initLiveChannel()
    const es = FakeEventSource.instances[0]!
    es.emitOpen()

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(25_000)
      es.emitMessage({ ping: true })
    }

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(connectionAttr()).toBe('connected')
  })

  it('rebuilds a stale channel in place instead of reloading, and the new sync applies', () => {
    document.body.innerHTML = '<span data-slot="s0">old</span>'
    const states = listen('stator:connection-state')
    handle = initLiveChannel()
    const first = FakeEventSource.instances[0]!
    first.emitOpen()

    // 70s of silence: two missed pings on a visible page → watchdog fires.
    vi.advanceTimersByTime(70_000)

    expect(FakeEventSource.instances).toHaveLength(2)
    expect(first.readyState).toBe(FakeEventSource.CLOSED)
    expect(states).toMatchObject([{ state: 'connected' }, { state: 'stale' }])

    // The rebuilt connection's server-side initial sync converges the DOM.
    const second = FakeEventSource.instances[1]!
    second.emitOpen()
    expect(connectionAttr()).toBe('connected')
    second.emitMessage({
      patches: [{ target: { kind: 'slot', id: 's0' }, op: 'text', value: 'synced' }],
    })
    expect(document.querySelector('[data-slot="s0"]')!.textContent).toBe('synced')

    // Another silent stretch produces exactly one more rebuild — the fresh
    // grace period on connect prevents a tight reconnect loop.
    vi.advanceTimersByTime(70_000)
    expect(FakeEventSource.instances).toHaveLength(3)
  })
})
