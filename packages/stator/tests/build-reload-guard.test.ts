// @env happy-dom
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import { initLiveChannel } from '../src/client/runtime.ts'
import { createApp } from '../src/server/create-app.ts'
import { activeConnectionCount } from '../src/server/sse.ts'
import { stubGlobal, unstubAllGlobals, useFakeTimers } from './helpers/mocks.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')
const boot = (buildId: string) =>
  createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
    buildId,
  })

const PATH = '/live-head'
const KEY = 'stator:reload'
const pageUrl = `http://localhost${PATH}`

type Fetch = (req: Request) => Response | Promise<Response>

/** Timers are mocked, so real I/O is waited on by yielding to the event loop. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 5000 && !done(); i++) await new Promise((r) => setImmediate(r))
  assert.ok(done(), 'the tab never settled')
}

/**
 * A browser tab reduced to what the guard needs: load HTML through `cdn`, run
 * the real client live channel, let its EventSource talk to `origin`, and
 * treat `location.reload()` as "load again".
 */
function openTab(origin: Fetch, cdn: (reload: boolean) => Response | Promise<Response>) {
  const t0 = Date.now()
  const tab = {
    loads: 0,
    reloadsAt: [] as number[],
    builds: [] as string[],
    connects: 0,
    answered: 0,
    open: 0,
    maxReloads: Number.POSITIVE_INFINITY,
    navigationType: 'navigate',
    async load(reload: boolean): Promise<void> {
      tab.loads++
      tab.navigationType = reload ? 'reload' : 'navigate'
      const html = await (await cdn(reload)).text()
      tab.builds.push(/stator-build" content="([^"]+)"/.exec(html)?.[1] ?? '(none)')
      document.head.innerHTML = /<head>([\s\S]*)<\/head>/.exec(html)![1]!
      document.documentElement.removeAttribute('data-stator-connection')
      initLiveChannel()
    },
    async visit(): Promise<void> {
      await tab.load(false)
      await tab.settled()
    },
    /** Pending writes have been read, every load has finished and every
     *  connection has had its first answer. */
    async settled(): Promise<void> {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
      await until(() => tab.connects === tab.loads && tab.answered === tab.connects)
    },
    async advance(ms: number, step = 1000): Promise<void> {
      for (let done = 0; done < ms; done += step) {
        mock.timers.tick(Math.min(step, ms - done))
        await tab.settled()
      }
    },
  }

  class OriginEventSource {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 2
    readyState = 0
    private listeners = new Map<string, Array<(e: unknown) => void>>()
    private reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    constructor(public url: string) {
      tab.connects++
      tab.open++
      void this.pump()
    }
    addEventListener(type: string, fn: (e: unknown) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
    }
    close() {
      if (this.readyState === 2) return
      this.readyState = 2
      tab.open--
      // Cancelling the body is what tells the server the client has gone.
      void this.reader?.cancel().catch(() => {})
    }
    private async pump() {
      const res = await origin(
        new Request(`http://localhost${this.url}`, {
          headers: { Cookie: `stator_sid=${crypto.randomUUID()}` },
        }),
      )
      this.reader = res.body!.getReader()
      if (this.readyState === 2) {
        tab.answered++
        void this.reader.cancel().catch(() => {})
        return
      }
      this.readyState = 1
      for (const fn of this.listeners.get('open') ?? []) fn(new Event('open'))
      const decoder = new TextDecoder()
      let buffer = ''
      let first = true
      for (;;) {
        const { value, done } = await this.reader
          .read()
          .catch(() => ({ value: undefined, done: true }))
        if (first) {
          first = false
          tab.answered++
        }
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let cut = buffer.indexOf('\n\n')
        while (cut !== -1) {
          const frame = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          if (this.readyState === 2) return
          if (frame.startsWith('data: ')) {
            for (const fn of this.listeners.get('message') ?? []) fn({ data: frame.slice(6) })
          }
          cut = buffer.indexOf('\n\n')
        }
      }
    }
  }

  stubGlobal('EventSource', OriginEventSource)
  stubGlobal('location', {
    pathname: PATH,
    search: '',
    href: pageUrl,
    reload: () => {
      tab.reloadsAt.push(Date.now() - t0)
      if (tab.reloadsAt.length < tab.maxReloads) void tab.load(true)
    },
  })
  mock.method(performance, 'getEntriesByType', () => [{ type: tab.navigationType }])
  return tab
}

const connectionAttr = () => document.documentElement.getAttribute('data-stator-connection')

async function staleHtmlFrom(buildId: string): Promise<string> {
  return (await (await boot(buildId)).fetch(new Request(pageUrl))).text()
}

beforeEach(() => {
  useFakeTimers()
  mock.method(console, 'warn', () => {})
})

afterEach(async () => {
  // Fire a hold left pending, against a reload that loads nothing.
  stubGlobal('location', { reload() {} })
  mock.timers.tick(60_000)
  document.head.innerHTML = ''
  initLiveChannel() // no live meta: closes the last channel and opens none
  await until(() => activeConnectionCount() === 0)
  document.documentElement.removeAttribute('data-stator-connection')
  unstubAllGlobals()
  sessionStorage.clear()
  mock.timers.reset()
  mock.restoreAll()
})

describe('guarded reload: HTML from build A served by a cache while the origin runs build B', () => {
  it('a cache that keeps serving the stored HTML: reloads at 0, 5, 20, 50 and 110 s only', async () => {
    const staleHtml = await staleHtmlFrom('build-A')
    const origin = await boot('build-B')
    const tab = openTab(origin.fetch, () => new Response(staleHtml))

    await tab.visit()
    assert.deepEqual(tab.reloadsAt, [0])

    // The reloaded page mismatched again: it waits, holding no connection.
    await tab.advance(4000)
    assert.deepEqual(tab.reloadsAt, [0])
    assert.equal(connectionAttr(), 'stale')
    assert.equal(tab.open, 0)
    assert.equal(tab.connects, 2)

    // Becoming visible during the hold does not reopen the channel.
    document.dispatchEvent(new Event('visibilitychange'))
    const shown = new Event('pageshow')
    Object.defineProperty(shown, 'persisted', { value: true })
    window.dispatchEvent(shown)
    assert.equal(tab.connects, 2)

    await tab.advance(116_000)
    assert.deepEqual(tab.reloadsAt, [0, 5000, 20_000, 50_000, 110_000])
    // One connection per page load, none retried while waiting.
    assert.equal(tab.connects, tab.loads)
    assert.equal(tab.open, 0)

    await tab.advance(60_000)
    assert.deepEqual(tab.reloadsAt, [0, 5000, 20_000, 50_000, 110_000, 170_000])
  })

  it('a cache that catches up: the tab recovers on the next attempt and clears its record', async () => {
    const staleHtml = await staleHtmlFrom('build-A')
    const origin = await boot('build-B')
    let fresh = false
    const tab = openTab(origin.fetch, () =>
      fresh ? origin.fetch(new Request(pageUrl)) : new Response(staleHtml),
    )

    await tab.visit()
    await tab.advance(4000)
    assert.deepEqual(tab.reloadsAt, [0])
    assert.equal(JSON.parse(sessionStorage.getItem(KEY)!).count, 2)

    fresh = true
    await tab.advance(1000)
    assert.deepEqual(tab.reloadsAt, [0, 5000])
    assert.deepEqual(tab.builds, ['build-A', 'build-A', 'build-B'])
    assert.equal(connectionAttr(), 'connected')

    // The first frame of the healthy channel (the sync, or the 25 s ping).
    await tab.advance(30_000)
    assert.equal(sessionStorage.getItem(KEY), null)
    assert.equal(tab.open, 1)

    await tab.advance(120_000)
    assert.deepEqual(tab.reloadsAt, [0, 5000])
  })

  it('control: a cache that goes to origin on reload: one reload, then a normal sync', async () => {
    const staleHtml = await staleHtmlFrom('build-A')
    const origin = await boot('build-B')
    const tab = openTab(origin.fetch, (reload) =>
      reload ? origin.fetch(new Request(pageUrl)) : new Response(staleHtml),
    )

    await tab.visit()
    await tab.advance(120_000)
    assert.deepEqual(tab.reloadsAt, [0])
    assert.deepEqual(tab.builds, ['build-A', 'build-B'])
    assert.equal(connectionAttr(), 'connected')
    assert.equal(tab.open, 1)
    assert.equal(activeConnectionCount(), 1)
  })

  it('a later deploy starts the sequence again', async () => {
    const staleHtml = await staleHtmlFrom('build-A')
    let origin = await boot('build-B')
    const tab = openTab(
      (req) => origin.fetch(req),
      () => new Response(staleHtml),
    )

    await tab.visit()
    await tab.advance(4000)
    assert.deepEqual(tab.reloadsAt, [0])

    origin = await boot('build-C')
    await tab.advance(1000)
    // The 5 s reload meets build C: a first mismatch, so it reloads at once,
    // and only the reload after that waits.
    assert.deepEqual(tab.reloadsAt, [0, 5000, 5000])
    await tab.advance(5000)
    assert.deepEqual(tab.reloadsAt, [0, 5000, 5000, 10_000])
  })

  it('a record older than 10 minutes is ignored', async () => {
    const staleHtml = await staleHtmlFrom('build-A')
    const origin = await boot('build-B')
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        path: PATH,
        reason: 'build',
        token: 'build-B',
        count: 4,
        at: Date.now() - 11 * 60_000,
      }),
    )
    const tab = openTab(origin.fetch, () => new Response(staleHtml))
    tab.maxReloads = 1

    await tab.visit()
    assert.deepEqual(tab.reloadsAt, [0])
  })

  it('a reload with no reason reloads at once, every time', async () => {
    const staleHtml = await staleHtmlFrom('build-A')
    const tab = openTab(
      () => new Response('data: {"directives":[{"type":"reload"}]}\n\n'),
      () => new Response(staleHtml),
    )
    tab.maxReloads = 6

    await tab.visit()
    assert.deepEqual(tab.reloadsAt, [0, 0, 0, 0, 0, 0])
    assert.equal(sessionStorage.getItem(KEY), null)
    assert.notEqual(connectionAttr(), 'stale')
  })

  it('storage that throws: one reload at once, then 5 s between attempts', async () => {
    const staleHtml = await staleHtmlFrom('build-A')
    const origin = await boot('build-B')
    const blocked = () => {
      throw new Error('SecurityError')
    }
    stubGlobal('sessionStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })
    const tab = openTab(origin.fetch, () => new Response(staleHtml))

    await tab.visit()
    assert.deepEqual(tab.reloadsAt, [0])

    await tab.advance(4000)
    assert.equal(connectionAttr(), 'stale')
    assert.equal(tab.open, 0)

    await tab.advance(16_000)
    assert.deepEqual(tab.reloadsAt, [0, 5000, 10_000, 15_000, 20_000])
    assert.equal(tab.connects, tab.loads)
  })

  it('storage that cannot be written falls back the same way', async () => {
    const staleHtml = await staleHtmlFrom('build-A')
    const origin = await boot('build-B')
    stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    })
    const tab = openTab(origin.fetch, () => new Response(staleHtml))

    await tab.visit()
    await tab.advance(10_000)
    assert.deepEqual(tab.reloadsAt, [0, 5000, 10_000])
  })
})
