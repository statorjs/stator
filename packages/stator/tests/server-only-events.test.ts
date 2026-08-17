import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/server/create-app.ts'
import { defineMachine } from '../src/server/define-machine.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures/server-only')

const boot = () =>
  createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
  })
type App = Awaited<ReturnType<typeof boot>>

const statusOf = (html: string) => html.match(/Status: <span[^>]*>([^<]*)</)?.[1]

const get = (app: App, cookie?: string) =>
  app.fetch(new Request('http://localhost/pay', { headers: cookie ? { Cookie: cookie } : {} }))

const post = (app: App, cookie: string, event: object) =>
  app.fetch(
    new Request('http://localhost/__events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stator-Route': 'GET /pay',
        Cookie: cookie,
      },
      body: JSON.stringify({ machine: 'PayMachine', event }),
    }),
  )

describe('defineMachine — serverOnly normalization', () => {
  it('defaults to [] when omitted', () => {
    const m = defineMachine({
      name: 'A',
      lifecycle: 'session',
      events: {} as { type: 'X' },
      context: {},
      initial: 's',
      states: { s: {} },
    })
    expect(m.serverOnly).toEqual([])
  })

  it('passes the declared list through', () => {
    const m = defineMachine({
      name: 'B',
      lifecycle: 'session',
      events: {} as { type: 'X' } | { type: 'DONE' },
      serverOnly: ['DONE'],
      context: {},
      initial: 's',
      states: { s: {} },
    })
    expect(m.serverOnly).toEqual(['DONE'])
  })
})

describe('serverOnly wire gate at /__events', () => {
  it('rejects a forged server-only completion with 403, leaving state untouched', async () => {
    const app = await boot()
    const r1 = await get(app)
    const cookie = r1.headers.get('set-cookie')!.split(';')[0]!
    expect(statusOf(await r1.text())).toBe('idle')

    const forged = await post(app, cookie, { type: 'CHARGE_APPROVED', receiptId: 'rcpt_forged' })
    expect(forged.status).toBe(403)
    expect((await forged.json()).error).toMatch(/server-only/)

    // The forgery changed nothing — still idle, no receipt.
    expect(statusOf(await (await get(app, cookie)).text())).toBe('idle')
  })

  it('allows the client intent event, and the server-only completion still settles via the effect', async () => {
    const app = await boot()
    const r1 = await get(app)
    const cookie = r1.headers.get('set-cookie')!.split(';')[0]!

    // CHARGE is a legitimate client event — not server-only — so it passes.
    const charge = await post(app, cookie, { type: 'CHARGE' })
    expect(charge.status).not.toBe(403)

    // The charge effect returns CHARGE_APPROVED on the INTERNAL dispatch path
    // (never /__events), so the gate can't block it: the machine reaches `paid`.
    await vi.waitFor(
      async () => {
        expect(statusOf(await (await get(app, cookie)).text())).toBe('paid')
      },
      { timeout: 2000, interval: 10 },
    )
  })

  it('does not 403 events that are not declared server-only', async () => {
    const app = await boot()
    const cookie = (await get(app)).headers.get('set-cookie')!.split(';')[0]!
    // CHARGE isn't in serverOnly; unknown-but-not-server-only events also aren't gated here.
    expect((await post(app, cookie, { type: 'CHARGE' })).status).not.toBe(403)
  })
})
