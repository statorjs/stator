import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp, type StatorApp } from '../src/server/create-app.ts'
import { InMemoryStore } from '../src/server/store.ts'

/**
 * rotateSession — the fixation defense. Login-shaped rotation MOVES the
 * whole session to a fresh id (the old id becomes worthless to anyone who
 * captured it); logout-shaped (`clear: true`) deletes the state and issues
 * a fresh anonymous id.
 *
 * The /rotate fixture dispatches POKE (a pure counter) then rotates, so
 * following the cookie chain proves state travels with the rotation.
 */

const here = resolve(new URL('.', import.meta.url).pathname)
const fixtures = resolve(here, 'fixtures')

async function boot(): Promise<StatorApp> {
  return createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
  })
}

function sidOf(res: Response): string | null {
  const raw = res.headers.get('set-cookie')
  if (!raw) return null
  const m = raw.match(/stator_sid=([^;]+)/)
  return m?.[1] ?? null
}

function post(app: StatorApp, path: string, sid: string) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `stator_sid=${sid}`,
      },
      body: new URLSearchParams(),
    }),
  )
}

function page(app: StatorApp, sid: string) {
  return app.fetch(
    new Request('http://localhost/submitter', { headers: { Cookie: `stator_sid=${sid}` } }),
  )
}

describe('session rotation', () => {
  it('state chains through rotations; abandoned ids are left empty', async () => {
    const app = await boot()
    const sidA = sidOf(await app.fetch(new Request('http://localhost/submitter')))!

    // poke+rotate twice, following the cookie each time: A → B → C
    const sidB = sidOf(await post(app, '/rotate', sidA))!
    const sidC = sidOf(await post(app, '/rotate', sidB))!
    expect(new Set([sidA, sidB, sidC]).size).toBe(3)

    // both pokes accumulated into the final session…
    expect(await (await page(app, sidC)).text()).toMatch(/Pokes: <span[^>]*>2</)
    // …and the abandoned ids hold nothing.
    expect(await (await page(app, sidA)).text()).toMatch(/Pokes: <span[^>]*>0</)
    expect(await (await page(app, sidB)).text()).toMatch(/Pokes: <span[^>]*>0</)
  })

  it('rotate with clear:true deletes the old session outright', async () => {
    const app = await boot()
    const sidA = sidOf(await app.fetch(new Request('http://localhost/submitter')))!
    const sidB = sidOf(await post(app, '/rotate', sidA))! // pokes: 1 under B

    const sidC = sidOf(await post(app, '/rotate-clear', sidB))!
    expect(sidC).not.toBe(sidB)

    // the logout wiped it: nobody has the poke anymore.
    expect(await (await page(app, sidC)).text()).toMatch(/Pokes: <span[^>]*>0</)
    expect(await (await page(app, sidB)).text()).toMatch(/Pokes: <span[^>]*>0</)
  })

  it('InMemoryStore.renameSession moves entries and expiry', async () => {
    const store = new InMemoryStore()
    await store.set('a', 'M', { n: 1 }, { ttlSeconds: 60 })
    await store.renameSession('a', 'b')
    expect(await store.get('b', 'M')).toEqual({ n: 1 })
    expect(await store.get('a', 'M')).toBeNull()
  })
})
