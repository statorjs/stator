import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures/app-machine-events')

const boot = () =>
  createApp({
    events: { gate: 'off' },
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
  })

const countOf = (html: string) => html.match(/Count: <span[^>]*>([^<]*)</)?.[1]

describe('app machines at /__events', () => {
  it('refuses a browser event to an app machine with 403, leaving state untouched', async () => {
    const app = await boot()
    const page = await app.fetch(new Request('http://localhost/tally'))
    assert.equal(countOf(await page.text()), '0')

    const res = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /tally',
        },
        body: JSON.stringify({ machine: 'TallyMachine', event: { type: 'BUMP' } }),
      }),
    )
    assert.equal(res.status, 403)
    assert.match((await res.json()).error, /app machine "TallyMachine".*session machine/)

    const after = await app.fetch(new Request('http://localhost/tally'))
    assert.equal(countOf(await after.text()), '0')
  })
})
