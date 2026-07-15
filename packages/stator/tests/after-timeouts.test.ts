import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const efFixtures = resolve(here, 'fixtures/entry-effects')

const boot = () =>
  createApp({
    machinesDir: resolve(efFixtures, 'machines'),
    routesDir: resolve(efFixtures, 'routes'),
  })
type App = Awaited<ReturnType<typeof boot>>

const statusOf = (html: string) => html.match(/Status: <span[^>]*>([^<]*)</)?.[1]

const get = (app: App, cookie?: string) =>
  app.fetch(
    new Request('http://localhost/timeout-loader', {
      headers: cookie ? { Cookie: cookie } : {},
    }),
  )

const statusVia = async (app: App, cookie: string) =>
  statusOf(await (await get(app, cookie)).text())

describe('`after` state timeouts', () => {
  it('fires after the delay, rescuing a state whose entry effect never completes', async () => {
    const app = await boot()
    const r1 = await get(app)
    const cookie = r1.headers.get('set-cookie')!.split(';')[0]!
    expect(statusOf(await r1.text())).toBe('loading') // initial render, timer armed

    // loading.entry returns null (no LOADED) — only the `after` timer moves the
    // machine on. It fires ~20ms later, re-enters TIMEOUT, and lands `error`.
    await vi.waitFor(
      async () => {
        expect(await statusVia(app, cookie)).toBe('error')
      },
      { timeout: 2000, interval: 10 },
    )
  })

  it('is cancelled when the state is left before the timeout fires', async () => {
    const app = await boot()
    const r1 = await get(app)
    const cookie = r1.headers.get('set-cookie')!.split(';')[0]!

    // Leave `loading` well before its 20ms timeout by dispatching LOADED.
    const res = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /timeout-loader',
          Cookie: cookie,
        },
        body: JSON.stringify({ machine: 'TimeoutLoaderMachine', event: { type: 'LOADED' } }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await statusVia(app, cookie)).toBe('ready')

    // Past the original timeout: the cancelled timer must not fire TIMEOUT, so
    // the machine stays `ready` rather than being knocked to `error`.
    await new Promise((r) => setTimeout(r, 60))
    expect(await statusVia(app, cookie)).toBe('ready')
  })
})
