import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The wire contract: an event posted from the page comes back as patches to
 * that page. The rules themselves are tested in todos.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url))
let app: import('@statorjs/stator/dev').DevApp
let cookie: string

before(async () => {
  const { createDevApp } = await import('@statorjs/stator/dev')
  app = await createDevApp({
    root: resolve(here, '..'),
    machinesDir: resolve(here, '../machines'),
    routesDir: resolve(here, '../routes'),
    staticDir: resolve(here, '../static'),
  })
  const page = await app.fetch(new Request('http://test/'))
  cookie = page.headers.get('set-cookie')!.split(';')[0]!
}, { timeout: 30_000 })

after(async () => {
  await app.close()
})

type Patch = { op: string; name?: string; value?: string | null }

async function send(event: object): Promise<Patch[]> {
  const res = await app.fetch(
    new Request('http://test/__events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /', Cookie: cookie },
      body: JSON.stringify({ machine: 'TodosMachine', event }),
    }),
  )
  assert.equal(res.status, 200)
  return (await res.json()).patches
}

describe('todos over the wire', () => {
  it('adding a todo patches the count; toggling it patches aria-checked', async () => {
    const added = await send({ type: 'ADD', title: 'feed the cat' })
    assert.ok(JSON.stringify(added).includes('1 item left'), JSON.stringify(added))

    const toggled = await send({ type: 'TOGGLE', id: 't0' })
    assert.ok(
      toggled.some((p) => p.name === 'aria-checked' && p.value === 'true'),
      JSON.stringify(toggled),
    )
  })

  it('refuses an event no page sends', async () => {
    const res = await app.fetch(
      new Request('http://test/__events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /', Cookie: cookie },
        body: JSON.stringify({ machine: 'TodosMachine', event: { type: 'EDIT_SAVE', id: 't0', title: 'x' } }),
      }),
    )
    assert.equal(res.status, 403)
  })
})
