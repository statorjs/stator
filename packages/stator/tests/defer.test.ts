import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/create-app.ts'
import { createRenderState, registerBinding } from '../src/server/render-context.ts'
import { deferKicks, resetDeferKicks } from './fixtures/defer/kick-count.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures/defer')

const boot = () =>
  createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
  })

describe('defer: blocking-inline resolution', () => {
  it('renders sync, async, and error-arm defers to complete HTML — no placeholder leaks', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/basics'))
    expect(res.status).toBe(200)
    const body = await res.text()

    expect(body).toContain('SYNC-VALUE') // synchronous thunk fulfilled inline
    expect(body).toContain('ASYNC-VALUE') // awaited before flush
    expect(body).toContain('ERROR-ARM') // rejection rendered its error arm
    // The sentinel is fully replaced — no unresolved placeholder reaches the client.
    expect(body).not.toContain('<!--defer:')
  })

  it('kicks a defer thunk once on a cold GET and never on the /__events re-diff', async () => {
    resetDeferKicks()
    const app = await boot()

    const first = await app.fetch(new Request('http://localhost/counter'))
    expect(first.status).toBe(200)
    const cookie = first.headers.get('set-cookie')!.split(';')[0]!
    expect(deferKicks()).toBe(1) // fired once on the cold render

    // A POST re-renders the baseline under the session lock (resolveDeferred=false);
    // the defer thunk must NOT run there — that would be I/O under the lock.
    const post = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /counter',
          Cookie: cookie,
        },
        body: JSON.stringify({ machine: 'Pinger', event: { type: 'PING' } }),
      }),
    )
    expect(post.status).toBe(200)
    expect(deferKicks()).toBe(1) // still once
  })

  it('a machine read() inside a defer arm fails the render (does not silently freeze)', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/bad-read'))
    expect(res.status).toBe(500)
  })
})

describe('defer: the runtime guard (registerBinding under deferDepth)', () => {
  it('rejects a binding registered inside a defer arm with a door-pointing message', () => {
    const state = createRenderState('sid', 'GET /x')
    state.deferDepth = 1
    expect(() =>
      registerBinding(state, {
        slotId: 's0',
        machineName: 'Cart',
        selector: () => 0,
        lastValue: 0,
        kind: 'text',
      }),
    ).toThrow(/cannot appear inside a defer\(\) arm/)
  })
})
