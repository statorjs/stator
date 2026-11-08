// @env happy-dom
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { initLiveChannel } from '../src/client/runtime.ts'
import { stubGlobal, unstubAllGlobals, useFakeTimers } from './helpers/mocks.ts'

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
  useFakeTimers()
  stubGlobal('EventSource', FakeEventSource)
  FakeEventSource.instances = []
  document.head.innerHTML = '<meta name="stator-live" content="true">'
  mock.method(console, 'warn', () => {})
  mock.method(console, 'error', () => {})
})

afterEach(() => {
  handle?.close()
  handle = undefined
  for (const c of cleanups.splice(0)) c()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-stator-connection')
  // `hidden` is stamped onto the document itself, so it outlives the test
  // that set it unless it's put back.
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  unstubAllGlobals()
  mock.timers.reset()
  mock.restoreAll()
})

function connectionAttr(): string | null {
  return document.documentElement.getAttribute('data-stator-connection')
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** `pageshow`'s `persisted` flag is what distinguishes a bfcache restore from
 *  an ordinary load; happy-dom has no PageTransitionEvent, so stamp it on. */
function firePageShow(persisted: boolean): void {
  const e = new Event('pageshow')
  Object.defineProperty(e, 'persisted', { value: persisted })
  window.dispatchEvent(e)
}

describe('live channel (SSE client)', () => {
  it('marks the page connected on open and applies pushed patches', () => {
    document.body.innerHTML = '<span data-slot="s0">old</span>'
    handle = initLiveChannel()
    assert.equal(FakeEventSource.instances.length, 1)
    const es = FakeEventSource.instances[0]!

    es.emitOpen()
    assert.equal(connectionAttr(), 'connected')

    es.emitMessage({ patches: [{ target: { kind: 'slot', id: 's0' }, op: 'text', value: 'new' }] })
    assert.equal(document.querySelector('[data-slot="s0"]')!.textContent, 'new')
  })

  it('does nothing on a non-live route', () => {
    document.head.innerHTML = ''
    handle = initLiveChannel()
    assert.equal(handle, undefined)
    assert.equal(FakeEventSource.instances.length, 0)
    assert.equal(connectionAttr(), null)
  })

  it('announces disconnected once across repeated errors (change guard)', () => {
    const states = listen('stator:connection-state')
    handle = initLiveChannel()
    const es = FakeEventSource.instances[0]!

    es.emitOpen()
    es.emitError()
    es.emitError()
    es.emitError()

    assert.equal(connectionAttr(), 'disconnected')
    assert.partialDeepStrictEqual(states, [{ state: 'connected' }, { state: 'disconnected' }])
  })

  it('stays on one connection while ping frames arrive', () => {
    handle = initLiveChannel()
    const es = FakeEventSource.instances[0]!
    es.emitOpen()

    for (let i = 0; i < 5; i++) {
      mock.timers.tick(25_000)
      es.emitMessage({ ping: true })
    }

    assert.equal(FakeEventSource.instances.length, 1)
    assert.equal(connectionAttr(), 'connected')
  })

  it('rebuilds a stale channel in place instead of reloading, and the new sync applies', () => {
    document.body.innerHTML = '<span data-slot="s0">old</span>'
    const states = listen('stator:connection-state')
    handle = initLiveChannel()
    const first = FakeEventSource.instances[0]!
    first.emitOpen()

    // 70s of silence: two missed pings on a visible page → watchdog fires.
    mock.timers.tick(70_000)

    assert.equal(FakeEventSource.instances.length, 2)
    assert.equal(first.readyState, FakeEventSource.CLOSED)
    assert.partialDeepStrictEqual(states, [{ state: 'connected' }, { state: 'stale' }])

    // The rebuilt connection's server-side initial sync converges the DOM.
    const second = FakeEventSource.instances[1]!
    second.emitOpen()
    assert.equal(connectionAttr(), 'connected')
    second.emitMessage({
      patches: [{ target: { kind: 'slot', id: 's0' }, op: 'text', value: 'synced' }],
    })
    assert.equal(document.querySelector('[data-slot="s0"]')!.textContent, 'synced')

    // Another silent stretch produces exactly one more rebuild — the fresh
    // grace period on connect prevents a tight reconnect loop.
    mock.timers.tick(70_000)
    assert.equal(FakeEventSource.instances.length, 3)
  })
})

describe('live channel — proactive release', () => {
  it('hands the socket back after 30s hidden and resyncs on return', () => {
    document.body.innerHTML = '<span data-slot="s0">old</span>'
    const states = listen('stator:connection-state')
    handle = initLiveChannel()
    const first = FakeEventSource.instances[0]!
    first.emitOpen()

    setHidden(true)
    mock.timers.tick(29_000)
    assert.equal(first.readyState, FakeEventSource.OPEN) // still inside the grace

    mock.timers.tick(2_000)
    assert.equal(first.readyState, FakeEventSource.CLOSED)
    assert.equal(connectionAttr(), 'idle')
    assert.equal(FakeEventSource.instances.length, 1) // released, not rebuilt

    setHidden(false)
    assert.equal(FakeEventSource.instances.length, 2)
    const second = FakeEventSource.instances[1]!
    second.emitOpen()
    assert.equal(connectionAttr(), 'connected')

    // Reconnect is a full resync — the server's initial sync converges the DOM
    // over whatever it missed while released.
    second.emitMessage({
      patches: [{ target: { kind: 'slot', id: 's0' }, op: 'text', value: 'caught up' }],
    })
    assert.equal(document.querySelector('[data-slot="s0"]')!.textContent, 'caught up')
    assert.partialDeepStrictEqual(states, [
      { state: 'connected' },
      { state: 'idle' },
      { state: 'connected' },
    ])
  })

  it('keeps the connection across a brief hide (alt-tab is not abandonment)', () => {
    handle = initLiveChannel()
    const es = FakeEventSource.instances[0]!
    es.emitOpen()

    for (let i = 0; i < 3; i++) {
      setHidden(true)
      mock.timers.tick(20_000)
      setHidden(false)
      mock.timers.tick(1_000)
    }

    assert.equal(es.readyState, FakeEventSource.OPEN)
    assert.equal(FakeEventSource.instances.length, 1)
    assert.equal(connectionAttr(), 'connected')
  })

  it('reports idle, not disconnected — offline banners key off the fault states', () => {
    handle = initLiveChannel()
    FakeEventSource.instances[0]!.emitOpen()
    setHidden(true)
    mock.timers.tick(31_000)

    // The three shipped apps hang `body::before` off these two selectors; a
    // deliberate release must not trip them on every tab switch.
    assert.notEqual(connectionAttr(), 'disconnected')
    assert.notEqual(connectionAttr(), 'stale')
    assert.equal(connectionAttr(), 'idle')
  })

  it('does not run the staleness watchdog while released', () => {
    handle = initLiveChannel()
    FakeEventSource.instances[0]!.emitOpen()
    setHidden(true)
    mock.timers.tick(31_000)
    assert.equal(FakeEventSource.instances.length, 1)

    // Long past STALE_MS. A released channel is not a stale one — the watchdog
    // must not resurrect a connection for a page nobody is watching.
    mock.timers.tick(300_000)
    assert.equal(FakeEventSource.instances.length, 1)
    assert.equal(connectionAttr(), 'idle')
  })

  it('releases on pagehide and reconnects on a bfcache restore', () => {
    handle = initLiveChannel()
    const first = FakeEventSource.instances[0]!
    first.emitOpen()

    window.dispatchEvent(new Event('pagehide'))
    assert.equal(first.readyState, FakeEventSource.CLOSED)
    assert.equal(connectionAttr(), 'idle')

    firePageShow(true)
    assert.equal(FakeEventSource.instances.length, 2)
    FakeEventSource.instances[1]!.emitOpen()
    assert.equal(connectionAttr(), 'connected')
  })

  it('ignores a non-persisted pageshow (ordinary load, runtime already connected)', () => {
    handle = initLiveChannel()
    FakeEventSource.instances[0]!.emitOpen()
    firePageShow(false)
    assert.equal(FakeEventSource.instances.length, 1)
  })

  it('releases immediately on freeze — a frozen tab runs no timers', () => {
    handle = initLiveChannel()
    const first = FakeEventSource.instances[0]!
    first.emitOpen()

    setHidden(true)
    document.dispatchEvent(new Event('freeze'))
    assert.equal(first.readyState, FakeEventSource.CLOSED)
    assert.equal(connectionAttr(), 'idle')

    setHidden(false)
    document.dispatchEvent(new Event('resume'))
    assert.equal(FakeEventSource.instances.length, 2)
  })

  it('replaces rather than stacks when the channel is re-initialized', () => {
    handle = initLiveChannel()
    const first = FakeEventSource.instances[0]!
    first.emitOpen()

    handle = initLiveChannel()
    assert.equal(first.readyState, FakeEventSource.CLOSED)
    assert.equal(FakeEventSource.instances.length, 2)

    // The superseded channel's watchdog is gone too — otherwise its interval
    // would keep firing forever with nothing able to reach it.
    FakeEventSource.instances[1]!.emitOpen()
    mock.timers.tick(70_000)
    assert.equal(FakeEventSource.instances.length, 3)
  })

  it('emits the raw envelope for observers before interpreting it', () => {
    const seen = listen('stator:live-message')
    handle = initLiveChannel()
    const es = FakeEventSource.instances[0]!
    es.emitOpen()
    es.emitMessage({ dev: { type: 'error', message: 'boom' } })

    assert.partialDeepStrictEqual(seen, [{ envelope: { dev: { type: 'error', message: 'boom' } } }])
  })
})
