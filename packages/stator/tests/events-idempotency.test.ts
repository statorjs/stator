import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp, type StatorApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

async function boot(): Promise<StatorApp> {
  return createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
  })
}

async function cookieFor(app: StatorApp, path: string): Promise<string> {
  const res = await app.fetch(new Request(`http://localhost${path}`))
  return res.headers.get('set-cookie')!.split(';')[0]!
}

async function postIncrement(app: StatorApp, cookie: string, eventId?: string): Promise<Response> {
  return app.fetch(
    new Request('http://localhost/__events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stator-Route': 'GET /',
        Cookie: cookie,
      },
      body: JSON.stringify({
        machine: 'CounterMachine',
        event: { type: 'INCREMENT' },
        ...(eventId ? { eventId } : {}),
      }),
    }),
  )
}

/** Open the SSE stream and return an accumulating reader (same harness shape
 *  as sse.test.ts — kept file-local per repo style). */
async function openSse(app: StatorApp, routeKey: string, cookie: string) {
  const abort = new AbortController()
  const res = await app.fetch(
    new Request(`http://localhost/__sse?route=${encodeURIComponent(routeKey)}`, {
      headers: { Cookie: cookie },
      signal: abort.signal,
    }),
  )
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pump = (async () => {
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
      }
    } catch {
      // stream closed/aborted — fine
    }
  })()
  return {
    async readUntil(predicate: (text: string) => boolean, timeoutMs = 3000): Promise<string> {
      const deadline = Date.now() + timeoutMs
      while (!predicate(buffer) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15))
      }
      return buffer
    },
    close() {
      abort.abort()
      reader.cancel().catch(() => {})
      void pump
    },
  }
}

describe('/__events idempotency (eventId replay cache)', () => {
  it('replays a duplicate eventId byte-for-byte without re-committing', async () => {
    const app = await boot()
    const cookie = await cookieFor(app, '/')

    const first = await postIncrement(app, cookie, 'evt-1')
    expect(first.status).toBe(200)
    const firstBody = await first.text()
    expect(firstBody).toContain('count is 1')

    const dup = await postIncrement(app, cookie, 'evt-1')
    expect(dup.status).toBe(200)
    expect(await dup.text()).toBe(firstBody)

    // One commit total: a fresh render still shows 1.
    const page = await app.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
    expect(await page.text()).toContain('count is 1')
  })

  it('commits twice when no eventId is sent (old behavior)', async () => {
    const app = await boot()
    const cookie = await cookieFor(app, '/')

    await postIncrement(app, cookie)
    await postIncrement(app, cookie)

    const page = await app.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
    expect(await page.text()).toContain('count is 2')
  })

  it('does not fan out again on replay', async () => {
    const app = await boot()

    // Session A watches the live board; session B pings (bumps the board).
    const cookieA = await cookieFor(app, '/board')
    const sse = await openSse(app, 'GET /board', cookieA)
    try {
      await sse.readUntil((t) => t.includes(': open'))

      const cookieB = await cookieFor(app, '/ping')
      const ping = (eventId: string) =>
        app.fetch(
          new Request('http://localhost/__events', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Stator-Route': 'GET /ping',
              Cookie: cookieB,
            },
            body: JSON.stringify({ machine: 'PingMachine', event: { type: 'PING' }, eventId }),
          }),
        )

      expect((await ping('ping-1')).status).toBe(200)
      await sse.readUntil((t) => /"value":"1"/.test(t))

      // Duplicate: replayed, no second bump pushed to A.
      expect((await ping('ping-1')).status).toBe(200)

      // A THIRD genuine ping lands as 2 — the duplicate never became a bump
      // (had it, this would be 3).
      expect((await ping('ping-2')).status).toBe(200)
      const buffer = await sse.readUntil((t) => /"value":"2"/.test(t))
      expect(buffer).toContain('"value":"2"')
      expect(buffer).not.toContain('"value":"3"')
    } finally {
      sse.close()
    }
  })

  it('evicts the oldest entry past the per-session bound', async () => {
    const app = await boot()
    const cookie = await cookieFor(app, '/')

    for (let i = 1; i <= 33; i++) {
      expect((await postIncrement(app, cookie, `evt-${i}`)).status).toBe(200)
    }
    // evt-1 was evicted on the 33rd insert — replaying it commits again.
    const replayed = await postIncrement(app, cookie, 'evt-1')
    expect(await replayed.text()).toContain('count is 34')
  })

  it('rejects an oversized eventId', async () => {
    const app = await boot()
    const cookie = await cookieFor(app, '/')
    const res = await postIncrement(app, cookie, 'x'.repeat(129))
    expect(res.status).toBe(400)
  })
})
