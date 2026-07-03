import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/create-app.ts'
import { activeSessionLockCount, withSessionLock } from '../src/server/session-lock.ts'
import { InMemoryStore, type Store } from '../src/server/store.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Store decorator that inserts real async latency into get/set, widening the
 *  load → mutate → persist window enough that unserialized concurrent
 *  mutations reliably interleave (and lose writes). */
class SlowStore implements Store {
  constructor(
    private inner: Store,
    private delayMs: number,
  ) {}
  async get(sid: string, machine: string): Promise<unknown | null> {
    await sleep(this.delayMs)
    return this.inner.get(sid, machine)
  }
  async set(
    sid: string,
    machine: string,
    snapshot: unknown,
    opts?: { ttlSeconds?: number },
  ): Promise<void> {
    await sleep(this.delayMs)
    return this.inner.set(sid, machine, snapshot, opts)
  }
  has(sid: string, machine: string): Promise<boolean> {
    return this.inner.has(sid, machine)
  }
  deleteSession(sid: string): Promise<void> {
    return this.inner.deleteSession(sid)
  }
}

describe('withSessionLock', () => {
  it('serializes overlapping calls on the same session', async () => {
    const events: string[] = []
    const first = withSessionLock('sid', async () => {
      events.push('a-start')
      await sleep(20)
      events.push('a-end')
    })
    const second = withSessionLock('sid', async () => {
      events.push('b-start')
      events.push('b-end')
    })
    await Promise.all([first, second])
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('does not serialize across different sessions', async () => {
    const events: string[] = []
    const first = withSessionLock('sid-1', async () => {
      events.push('a-start')
      await sleep(20)
      events.push('a-end')
    })
    const second = withSessionLock('sid-2', async () => {
      events.push('b')
    })
    await Promise.all([first, second])
    expect(events).toEqual(['a-start', 'b', 'a-end'])
  })

  it('keeps the chain alive after a rejection', async () => {
    const failing = withSessionLock('sid', async () => {
      throw new Error('boom')
    })
    await expect(failing).rejects.toThrow('boom')
    const after = await withSessionLock('sid', async () => 'ok')
    expect(after).toBe('ok')
  })

  it('cleans up the lock map once a session settles', async () => {
    await withSessionLock('sid', async () => {
      await sleep(5)
    })
    // Cleanup runs on a microtask after the settled promise resolves.
    await sleep(0)
    expect(activeSessionLockCount()).toBe(0)
  })
})

describe('cross-path session serialization (lost-update regression)', () => {
  /** Boot the counter fixture app on a latency-injected store and return a
   *  session cookie whose CounterMachine has been rendered once. */
  async function slowApp() {
    const app = await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
      store: new SlowStore(new InMemoryStore(), 15),
    })
    const first = await app.fetch(new Request('http://localhost/'))
    const cookie = first.headers.get('set-cookie')!.split(';')[0]!
    return { app, cookie }
  }

  const incrementViaEvents = (app: Awaited<ReturnType<typeof slowApp>>['app'], cookie: string) =>
    app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /',
          Cookie: cookie,
        },
        body: JSON.stringify({ machine: 'CounterMachine', event: { type: 'INCREMENT' } }),
      }),
    )

  const incrementViaApiRoute = (app: Awaited<ReturnType<typeof slowApp>>['app'], cookie: string) =>
    app.fetch(
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { Accept: 'application/json', Cookie: cookie },
      }),
    )

  const renderedCount = async (app: Awaited<ReturnType<typeof slowApp>>['app'], cookie: string) => {
    const res = await app.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
    const html = await res.text()
    const m = html.match(/count is (\d+)/)
    return m ? Number(m[1]) : Number.NaN
  }

  it('two concurrent /__events on one session both land', async () => {
    const { app, cookie } = await slowApp()
    const [r1, r2] = await Promise.all([
      incrementViaEvents(app, cookie),
      incrementViaEvents(app, cookie),
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(await renderedCount(app, cookie)).toBe(2)
  })

  it('a concurrent /__events POST and API-route mutation both land', async () => {
    // Regression: these two entry points once held *separate* lock maps, so
    // their load → mutate → persist cycles interleaved and one write was lost.
    const { app, cookie } = await slowApp()
    const [r1, r2] = await Promise.all([
      incrementViaEvents(app, cookie),
      incrementViaApiRoute(app, cookie),
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(await renderedCount(app, cookie)).toBe(2)
  })

  it('concurrent API-route mutations on one session both land', async () => {
    const { app, cookie } = await slowApp()
    await Promise.all([incrementViaApiRoute(app, cookie), incrementViaApiRoute(app, cookie)])
    expect(await renderedCount(app, cookie)).toBe(2)
  })
})
