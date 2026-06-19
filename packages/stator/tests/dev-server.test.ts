import { describe, it, expect, afterAll } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevApp, type DevApp } from '../src/server/dev.ts'

/**
 * Phase 3a exit proof: a `.stator` template, compiled by Vite, rendered through
 * the real runtime in a running dev app — producing scoped HTML, SSR-injected
 * scoped CSS in <head>, and correct event patches.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/dev-app')

let app: DevApp | undefined
afterAll(async () => {
  await app?.close()
})

describe('dev server: .stator end to end', () => {
  it('renders a .stator route with scoped CSS in <head> and patches events', async () => {
    app = await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })

    const res = await app.fetch(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    const html = await res.text()

    // Template rendered through the runtime.
    expect(html).toContain('count is 0')
    // Scope attribute injected on elements (style block present → scoping on).
    const m = html.match(/data-s-([0-9a-f]{8})/)
    expect(m).toBeTruthy()
    const hash = m![1]
    // Scoped CSS injected into <head>.
    expect(html).toContain('<style data-stator-dev>')
    expect(html).toContain(`.label[data-s-${hash}]`)
    expect(html).toContain('rebeccapurple')

    // Event round-trip produces a patch for the bound slot.
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    const post = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /',
          Cookie: cookie,
        },
        body: JSON.stringify({ machine: 'CounterMachine', event: { type: 'INCREMENT' } }),
      }),
    )
    expect(post.status).toBe(200)
    const json = (await post.json()) as { patches: Array<{ op: string; value?: string }> }
    expect(json.patches.some((p) => p.value === 'count is 1')).toBe(true)
  })
})
