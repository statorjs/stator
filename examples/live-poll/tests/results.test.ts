import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'


/**
 * The per-poll JSON twin: created through the real form route, read back at
 * /p/:id.json — the poll's public shape only (no voter sessions).
 */

const here = dirname(fileURLToPath(import.meta.url))
let app: import('@statorjs/stator/dev').DevApp

before(async () => {
  const { createDevApp } = await import('@statorjs/stator/dev')
  app = await createDevApp({
    root: resolve(here, '..'),
    machinesDir: resolve(here, '../machines'),
    routesDir: resolve(here, '../routes'),
  })
}, { timeout: 30_000 })

after(async () => {
  await app.close()
})

describe('the /p/:id.json results route', () => {
  it('serves a created poll as JSON, voter sessions withheld', async () => {
    // Lazy sessions: the page GET sets no cookie; a presented sid resumes.
    const cookie = `stator_sid=${crypto.randomUUID()}`
    const form = new URLSearchParams({ question: 'Tabs or spaces?' })
    form.append('option', 'Tabs')
    form.append('option', 'Spaces')
    await app.fetch(
      new Request('http://test/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: form,
      }),
    )

    // The home page lists the new poll — lift its id from the link.
    const home = await (await app.fetch(new Request('http://test/'))).text()
    const id = home.match(/\/p\/([a-z0-9]+)/)?.[1]
    assert.ok(id)

    const res = await app.fetch(new Request(`http://test/p/${id}.json`))
    assert.equal(res.status, 200)
    assert.ok((res.headers.get('content-type'))?.includes('application/json'))
    assert.ok(res.headers.get('etag'))
    const poll = (await res.json()) as {
      question: string
      totalVotes: number
      options: Array<{ text: string; count: number }>
    }
    assert.equal(poll.question, 'Tabs or spaces?')
    assert.equal(poll.totalVotes, 0)
    assert.deepStrictEqual(poll.options.map((o) => o.text), ['Tabs', 'Spaces'])
    assert.ok(!(JSON.stringify(poll)).includes('voterSessions'))
  })

  it('an unknown poll id is a JSON 404', async () => {
    const res = await app.fetch(new Request('http://test/p/nope1234.json'))
    assert.equal(res.status, 404)
    assert.deepStrictEqual((await res.json()) as object, { error: 'no such poll' })
  })
})
