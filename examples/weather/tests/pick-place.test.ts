import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { after, before, describe, it, mock } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The wire test: a browser searches, picks a result by its position, and the
 * place appears. It runs the real app in-process; the only stand-in is the
 * outbound `fetch`, so no request leaves the machine.
 */

const here = dirname(fileURLToPath(import.meta.url))
let app: import('@statorjs/stator/dev').DevApp

const GEOCODER = {
  results: [
    { name: 'Reykjavik', country: 'Iceland', country_code: 'IS', latitude: 64.13, longitude: -21.9, timezone: 'Atlantic/Reykjavik' },
  ],
}

before(async () => {
  mock.method(globalThis, 'fetch', async (url: string | URL | Request) =>
    String(url).includes('geocoding')
      ? Response.json(GEOCODER)
      : new Response('unavailable', { status: 503 }),
  )
  const { createDevApp } = await import('@statorjs/stator/dev')
  app = await createDevApp({
    root: resolve(here, '..'),
    machinesDir: resolve(here, '../machines'),
    routesDir: resolve(here, '../routes'),
  })
}, { timeout: 30_000 })

after(async () => {
  await app.close()
  mock.restoreAll()
})

const cookie = `stator_sid=${crypto.randomUUID()}`
const page = async () => (await app.fetch(new Request('http://test/', { headers: { Cookie: cookie } }))).text()
// `X-Stator-Route` names the page the event comes from.
const send = (machine: string, event: object) =>
  app.fetch(
    new Request('http://test/__events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /', Cookie: cookie },
      body: JSON.stringify({ machine, event }),
    }),
  )

describe('picking a search result', () => {
  it('adds the place the server found, named by its row', async () => {
    assert.ok(!(await page()).includes('Reykjavik'))
    await send('SearchMachine', { type: 'SEARCH', query: 'reyk' })
    // The geocoding effect reports back after the response; wait for its row.
    let html = ''
    for (let i = 0; i < 100 && !html.includes('search-result'); i++) {
      await new Promise((r) => setTimeout(r, 20))
      html = await page()
    }
    assert.ok(html.includes('search-result'), 'the result is listed')

    const res = await send('SearchMachine', { type: 'PICK', index: 0 })
    assert.equal(res.status, 200)
    html = await page()
    assert.ok(html.includes('Reykjavik'), 'the place is on the page')
    assert.ok(!html.includes('search-result'), 'and the search is cleared')
  })

  it('refuses a place sent by the browser', async () => {
    const res = await send('WeatherMachine', {
      type: 'ADD_PLACE',
      place: { name: 'Nowhere', country: '', lat: 0, lon: 0, timezone: 'auto' },
    })
    assert.equal(res.status, 403)
    assert.ok(!(await page()).includes('Nowhere'))
  })
})
