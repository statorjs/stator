import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server/create-app.ts'
import { createRenderState, registerBinding } from '../src/server/render-context.ts'
import { deferKicks, resetDeferKicks } from './fixtures/defer/kick-count.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures/defer')

const boot = () =>
  createApp({
    // These fixtures post events their pages do not render.
    events: { gate: 'off' },
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
  })

describe('defer: blocking-inline resolution', () => {
  it('renders sync, async, and error-arm defers to complete HTML — no placeholder leaks', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/basics'))
    assert.equal(res.status, 200)
    const body = await res.text()

    assert.ok(body.includes('SYNC-VALUE')) // synchronous thunk fulfilled inline
    assert.ok(body.includes('ASYNC-VALUE')) // awaited before flush
    assert.ok(body.includes('ERROR-ARM')) // rejection rendered its error arm
    // The sentinel is fully replaced — no unresolved placeholder reaches the client.
    assert.ok(!body.includes('<!--defer:'))
  })

  it('kicks a defer thunk once on a cold GET and never on the /__events re-diff', async () => {
    resetDeferKicks()
    const app = await boot()

    const first = await app.fetch(new Request('http://localhost/counter'))
    assert.equal(first.status, 200)
    const cookie = first.headers.get('set-cookie')!.split(';')[0]!
    assert.equal(deferKicks(), 1) // fired once on the cold render

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
    assert.equal(post.status, 200)
    assert.equal(deferKicks(), 1) // still once
  })

  it('a machine read() inside a defer arm fails the render (does not silently freeze)', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/bad-read'))
    assert.equal(res.status, 500)
  })
})

describe('defer: the runtime guard (registerBinding under deferDepth)', () => {
  it('rejects a binding registered inside a defer arm with a door-pointing message', () => {
    const state = createRenderState('sid', 'GET /x')
    state.deferDepth = 1
    assert.throws(
      () =>
        registerBinding(state, {
          slotId: 's0',
          machineName: 'Cart',
          selector: () => 0,
          lastValue: 0,
          kind: 'text',
        }),
      /cannot appear inside a defer\(\) arm/,
    )
  })
})
