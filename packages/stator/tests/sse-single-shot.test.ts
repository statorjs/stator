import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp, type StatorApp } from '../src/server/create-app.ts'
import Tally from './fixtures/sse-probe/machines/tally.ts'

/**
 * Single-shot fan-out: ONE dispatch, one live connection, one push expected.
 *
 * The suite had no test that could distinguish a DROPPED push from a late one.
 * `dev-native.test.ts` drives its fan-out from a boot clock that re-fires every
 * 200ms, so a lost message is silently covered by the next tick; only
 * `dev-server.test.ts` dispatches once, and it does so through the Vite dev
 * server, which confuses "the fan-out is unreliable" with "the Vite hatch is
 * unreliable". This runs the same single-shot shape against `createApp` — the
 * production server, no dev wrapper, no module loader in the way — so the
 * shared `sse.ts`/`http.ts` fan-out is the only thing under test.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/sse-probe')

// `createApp` owns no listener here — every request goes through `fetch`, and
// each round aborts its own stream — so there is nothing to tear down.
let app: StatorApp | undefined

/** One full cycle: connect, confirm the stream is live, dispatch once, wait for
 *  the push. Returns how long the push took, or null if it never arrived. */
async function cycle(a: StatorApp, expected: number, budgetMs: number): Promise<number | null> {
  const abort = new AbortController()
  const res = await a.fetch(
    new Request(`http://localhost/__sse?route=${encodeURIComponent('GET /tally')}`, {
      headers: { Cookie: `stator_sid=${crypto.randomUUID()}` },
      signal: abort.signal,
    }),
  )
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pump = (async () => {
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) break
        buffer += decoder.decode(r.value, { stream: true })
      }
    } catch {
      // aborted — expected at teardown
    }
  })()

  try {
    const until = async (p: (t: string) => boolean, ms: number) => {
      const deadline = Date.now() + ms
      while (!p(buffer) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
      return p(buffer)
    }
    // The connection must be REGISTERED before the dispatch, or a miss would
    // just mean "raced the subscription" rather than "the fan-out dropped it".
    if (!(await until((t) => t.includes(': open'), 5000))) return null

    const started = Date.now()
    const result = await a.dispatchToApp(Tally, { type: 'BUMP', by: 1 })
    expect(result.committed).toBe(true)

    const arrived = await until((t) => t.includes(`"value":"${expected}"`), budgetMs)
    return arrived ? Date.now() - started : null
  } finally {
    abort.abort()
    reader.cancel().catch(() => {})
    void pump
  }
}

describe('SSE fan-out: single-shot delivery', () => {
  it('every one-shot dispatch reaches a live connection', async () => {
    app = await createApp({
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })

    const ROUNDS = 60
    const latencies: number[] = []
    const missed: number[] = []
    for (let i = 1; i <= ROUNDS; i++) {
      const ms = await cycle(app, i, 4000)
      if (ms === null) missed.push(i)
      else latencies.push(ms)
    }

    // A single dropped push is a real defect: with the connection confirmed
    // live before the dispatch and the commit confirmed after it, there is no
    // window where losing the message is correct behavior.
    expect(missed).toEqual([])
    // Delivery is in-process — a push measured in seconds means something is
    // stalling, even when it eventually lands.
    expect(Math.max(...latencies)).toBeLessThan(1000)
  }, 180_000)
})
