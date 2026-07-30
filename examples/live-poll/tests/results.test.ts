import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The per-poll JSON twin: created through the real form route, read back at
 * /p/:id.json — the poll's public shape only (no voter sessions).
 */

const here = dirname(fileURLToPath(import.meta.url))
let app: import('@statorjs/stator/dev').DevApp

beforeAll(async () => {
  const { createDevApp } = await import('@statorjs/stator/dev')
  app = await createDevApp({
    root: resolve(here, '..'),
    machinesDir: resolve(here, '../machines'),
    routesDir: resolve(here, '../routes'),
  })
}, 30_000)

afterAll(async () => {
  await app.close()
})

describe('the /p/:id.json results route', () => {
  it('serves a created poll as JSON, voter sessions withheld', async () => {
    const page = await app.fetch(new Request('http://test/new'))
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!
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
    expect(id).toBeTruthy()

    const res = await app.fetch(new Request(`http://test/p/${id}.json`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('etag')).toBeTruthy()
    const poll = (await res.json()) as {
      question: string
      totalVotes: number
      options: Array<{ text: string; count: number }>
    }
    expect(poll.question).toBe('Tabs or spaces?')
    expect(poll.totalVotes).toBe(0)
    expect(poll.options.map((o) => o.text)).toEqual(['Tabs', 'Spaces'])
    expect(JSON.stringify(poll)).not.toContain('voterSessions')
  })

  it('an unknown poll id is a JSON 404', async () => {
    const res = await app.fetch(new Request('http://test/p/nope1234.json'))
    expect(res.status).toBe(404)
    expect((await res.json()) as object).toEqual({ error: 'no such poll' })
  })
})
