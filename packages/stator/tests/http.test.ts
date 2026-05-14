import { describe, it, expect } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
