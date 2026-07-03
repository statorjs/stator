import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

describe('HTTP layer', () => {
  it('renders a route on GET and patches a slot on POST /__events', async () => {
    const app = await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
    })

    const getResponse = await app.fetch(new Request('http://localhost/'))
    expect(getResponse.status).toBe(200)
    const html = await getResponse.text()
    expect(html).toContain('Counter')
    expect(html).toContain('<span data-slot="s0">count is 0</span>')
    expect(html).toContain('data-event-click=')

    const setCookie = getResponse.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
    const sessionCookie = setCookie!.split(';')[0]!

    const postResponse = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /',
          Cookie: sessionCookie,
        },
        body: JSON.stringify({
          machine: 'CounterMachine',
          event: { type: 'INCREMENT' },
        }),
      }),
    )
    expect(postResponse.status).toBe(200)
    const json = (await postResponse.json()) as {
      patches: Array<{
        target: { kind: string; id: string }
        op: string
        value?: string
        name?: string
      }>
    }
    expect(json.patches).toEqual([
      { target: { kind: 'slot', id: 's0' }, op: 'text', value: 'count is 1' },
    ])
  })

  it('dispatches to a machine via its imported def (typed, no magic string)', async () => {
    const app = await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
    })

    // Establish a session.
    const getResponse = await app.fetch(new Request('http://localhost/'))
    const cookie = getResponse.headers.get('set-cookie')!.split(';')[0]!

    // POST /submit → handler calls dispatch(CounterMachine, { type: 'INCREMENT' }).
    const post = await app.fetch(
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({}),
      }),
    )
    expect(post.status).toBe(200)

    // The dispatch persisted the touched machine: a fresh GET shows count 1.
    const after = await app.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
    const html = await after.text()
    expect(html).toContain('<span data-slot="s0">count is 1</span>')
  })

  it('auto-injects the client runtime once, before </body>', async () => {
    const app = await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
    })
    // /plain renders a full document with no hand-written runtime tag.
    const res = await app.fetch(new Request('http://localhost/plain'))
    const html = await res.text()
    const tags = html.match(/<script src="\/static\/client\.js">/g) ?? []
    expect(tags).toHaveLength(1)
    expect(html).toContain('<script src="/static/client.js"></script></body>')
  })

  it('does not double-inject when the document already references the runtime', async () => {
    const app = await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
    })
    // / (index.ts) still hand-includes the tag; the guard must not add a second.
    const res = await app.fetch(new Request('http://localhost/'))
    const html = await res.text()
    const tags = html.match(/\/static\/client\.js/g) ?? []
    expect(tags).toHaveLength(1)
  })

  it('does not inject or serve the dev inspector in production', async () => {
    const app = await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
    })
    const html = await (await app.fetch(new Request('http://localhost/plain'))).text()
    expect(html).not.toContain('/@stator/inspector.js')
    const asset = await app.fetch(new Request('http://localhost/@stator/inspector.js'))
    expect(asset.status).toBe(404)
  })

  it('rejects unknown machines with 404', async () => {
    const app = await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
    })

    const getResponse = await app.fetch(new Request('http://localhost/'))
    const cookie = getResponse.headers.get('set-cookie')!.split(';')[0]!

    const post = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /',
          Cookie: cookie,
        },
        body: JSON.stringify({ machine: 'NopeMachine', event: { type: 'X' } }),
      }),
    )
    expect(post.status).toBe(404)
  })

  it('rejects POST without route header', async () => {
    const app = await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
    })
    const post = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machine: 'CounterMachine', event: { type: 'INCREMENT' } }),
      }),
    )
    expect(post.status).toBe(400)
  })
})
