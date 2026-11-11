import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/build/build.ts'
import { loadProductionHead } from '../src/build/head.ts'
import { createApp } from '../src/server/create-app.ts'
import { createDevApp, type DevApp } from '../src/server/dev.ts'

/**
 * The `/__events` gate: an event is accepted only when the page it names
 * offers it, meaning some template or island that page can render sends
 * that event type (offered-events.test.ts covers how the list is read).
 * The fixture's cart handles `CHARGE_OK` and `CHARGE_TIMEOUT`, as an effect
 * and a timer would report them, and lists neither `serverOnly`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/offered-events')
const outDir = resolve(here, 'fixtures/.tmp-offered-events-dist')

type App = { fetch: (r: Request) => Response | Promise<Response> }

async function send(app: App, route: string, type: string, extra: object = {}): Promise<Response> {
  return app.fetch(
    new Request('http://localhost/__events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stator-Route': `GET ${route}` },
      body: JSON.stringify({ machine: 'CartMachine', event: { type, ...extra } }),
    }),
  )
}

const dev = (extra: Record<string, unknown> = {}): Promise<DevApp> =>
  createDevApp({
    root,
    machinesDir: resolve(root, 'machines'),
    routesDir: resolve(root, 'routes'),
    ...extra,
  })

describe('the event gate (dev server, read from source)', () => {
  let app: DevApp | undefined
  after(() => app?.close())

  it('accepts what the page offers, from a template and from an island', async () => {
    app = await dev()
    for (const [type, extra] of [
      ['ADD', { id: 'p1' }],
      ['REMOVE', { id: 'p1' }],
      ['CLEAR', {}],
      ['PING', {}],
    ] as const) {
      const res = await send(app, '/', type, extra)
      assert.equal(res.status, 200, type)
    }
  })

  it('accepts an event offered only in an arm that is not showing', async () => {
    // CHECKOUT sits in a `when` arm that is off for an empty cart. The list
    // is static, so the guard decides, not the gate.
    const res = await send(app!, '/', 'CHECKOUT')
    assert.equal(res.status, 200)
  })

  it('refuses an effect completion and a timer event no UI sends', async () => {
    for (const type of ['CHARGE_OK', 'CHARGE_TIMEOUT']) {
      const res = await send(app!, '/', type)
      assert.equal(res.status, 403, type)
      assert.deepEqual(await res.json(), { error: `route "GET /" offers no event "${type}"` })
    }
  })

  it('refuses an event another page offers but this one does not', async () => {
    assert.equal((await send(app!, '/bare', 'CLEAR')).status, 403)
    assert.equal((await send(app!, '/manual', 'ADD', { id: 'x' })).status, 403)
    assert.equal((await send(app!, '/manual', 'CLEAR')).status, 200)
  })

  it('leaves a route with a computed event type open', async () => {
    assert.equal((await send(app!, '/computed', 'PING')).status, 200)
    assert.equal((await send(app!, '/computed', 'CHARGE_OK')).status, 200)
  })

  it('events.gate "warn" and "off" let everything through', async () => {
    for (const gate of ['warn', 'off']) {
      const loose = await dev({ events: { gate } })
      try {
        assert.equal((await send(loose, '/bare', 'CLEAR')).status, 200, gate)
      } finally {
        await loose.close()
      }
    }
  })
})

describe('the event gate (built app, read from the manifest)', () => {
  after(() => rm(outDir, { recursive: true, force: true }))

  it('the build records each route’s offer, and stator start enforces it', {
    timeout: 60_000,
  }, async () => {
    await buildApp({ root, outDir })
    const manifest = JSON.parse(await readFile(join(outDir, 'stator-manifest.json'), 'utf8')) as {
      events: Record<string, { types: string[]; open: string[] }>
    }
    assert.deepEqual(manifest.events['index.stator.ts'], {
      types: ['ADD', 'CHECKOUT', 'CLEAR', 'PING', 'REMOVE'],
      open: [],
    })
    assert.deepEqual(manifest.events['bare.stator.ts'], { types: [], open: [] })
    assert.deepEqual(manifest.events['manual.ts'], { types: ['CLEAR'], open: [] })
    assert.equal(manifest.events['computed.stator.ts']?.open.length, 1)

    const { headExtras, buildId, machines, events } = await loadProductionHead(outDir)
    const app = await createApp({
      machinesDir: join(outDir, 'machines'),
      routesDir: join(outDir, 'routes'),
      headExtras,
      buildId,
      machineHashes: machines,
      offeredEvents: events,
    })
    assert.equal((await send(app, '/', 'ADD', { id: 'p1' })).status, 200)
    assert.equal((await send(app, '/', 'CHARGE_OK')).status, 403)
    assert.equal((await send(app, '/bare', 'CLEAR')).status, 403)
    assert.equal((await send(app, '/computed', 'CHARGE_OK')).status, 200)
  })

  it('a dist with no recorded offers is read from its own modules', async () => {
    const { headExtras, buildId, machines } = await loadProductionHead(outDir)
    const app = await createApp({
      root: outDir,
      machinesDir: 'machines',
      routesDir: 'routes',
      headExtras,
      buildId,
      machineHashes: machines,
    })
    assert.equal((await send(app, '/', 'ADD', { id: 'p1' })).status, 200)
    assert.equal((await send(app, '/', 'CHARGE_OK')).status, 403)
  })
})
