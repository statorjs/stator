import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createDevApp, type DevApp } from '../src/server/dev.ts'
import Tally from './fixtures/dev-app/machines/tally.ts'

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
        body: JSON.stringify({
          machine: 'CounterMachine',
          event: { type: 'INCREMENT' },
        }),
      }),
    )
    expect(post.status).toBe(200)
    const json = (await post.json()) as {
      patches: Array<{ op: string; value?: string }>
    }
    expect(json.patches.some((p) => p.value === 'count is 1')).toBe(true)
  })

  it('passes a raw Response from an api route through verbatim', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })
    // The Response is constructed inside a Vite-SSR-loaded route module and
    // checked by the Vite-SSR-loaded framework — the exact pairing where an
    // identity-only instanceof check has been reported to miss.
    const res = await app.fetch(new Request('http://localhost/raw-response', { method: 'POST' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, marker: 'raw-passthrough' })
  })

  it('renders a client component shell and injects its module script (3b 6c)', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })
    const html = await (await app.fetch(new Request('http://localhost/'))).text()

    // Server-rendered shell of the client component (custom element + markers,
    // directives stripped).
    expect(html).toContain('<tick-counter')
    expect(html).toContain('data-b="b0"')
    expect(html).not.toContain('on:click')
    // Its client module script is injected (served by Vite at the ?type=client URL).
    expect(html).toMatch(
      /<script type="module" src="\/templates\/tick-counter\.stator\?stator&type=client">/,
    )
  })

  it('stubs machine imports for the browser but serves them whole for SSR', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })

    // Browser-plane transform: the machine collapses to its identity stub.
    const browser = await app.vite.transformRequest('/machines/counter.ts')
    expect(browser?.code).toContain('CounterMachine')
    expect(browser?.code).not.toContain('INCREMENT')

    // SSR-plane transform: the real module, untouched.
    const ssr = await app.vite.transformRequest('/machines/counter.ts', { ssr: true })
    expect(ssr?.code).toContain('INCREMENT')
  })

  it('injects the Vite HMR client so the browser can receive reload signals', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })
    const html = await (await app.fetch(new Request('http://localhost/'))).text()
    expect(html).toContain('<script type="module" src="/@vite/client"></script>')
  })

  it('auto-injects and serves the dev inspector', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })
    const html = await (await app.fetch(new Request('http://localhost/'))).text()
    expect(html).toContain('<script src="/@stator/inspector.js" defer></script>')

    const asset = await app.fetch(new Request('http://localhost/@stator/inspector.js'))
    expect(asset.status).toBe(200)
    expect(asset.headers.get('Content-Type')).toContain('javascript')
    expect(await asset.text()).toContain('stator-inspector')
  })

  it('can disable the inspector via config', async () => {
    const noInspector = await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
      dev: { inspector: false },
    })
    try {
      const html = await (await noInspector.fetch(new Request('http://localhost/'))).text()
      expect(html).not.toContain('/@stator/inspector.js')
      const asset = await noInspector.fetch(new Request('http://localhost/@stator/inspector.js'))
      expect(asset.status).toBe(404)
    } finally {
      await noInspector.close()
    }
  })

  it('dispatchToApp commits and fans out to a live SSE connection', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })

    // Render the live page for a session cookie, then open its stream.
    const page = await app.fetch(new Request('http://localhost/tally'))
    expect(page.status).toBe(200)
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!

    const abort = new AbortController()
    const res = await app.fetch(
      new Request(`http://localhost/__sse?route=${encodeURIComponent('GET /tally')}`, {
        headers: { Cookie: cookie },
        signal: abort.signal,
      }),
    )
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const pump = (async () => {
      try {
        while (true) {
          const r = await reader.read()
          if (r.done) break
          buffer += decoder.decode(r.value, { stream: true })
        }
      } catch {
        // stream aborted — fine
      }
    })()
    const readUntil = async (predicate: (t: string) => boolean) => {
      const deadline = Date.now() + 3000
      while (!predicate(buffer) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15))
      }
      return buffer
    }

    try {
      await readUntil((t) => t.includes(': open'))

      // The def is natively imported (as a user's server.ts would) while the
      // dev app loaded its own copy through Vite — dispatchToApp resolves by
      // name, so the identities never need to match.
      const result = await app.dispatchToApp(Tally, { type: 'BUMP', by: 4 })
      expect(result.committed).toBe(true)

      // The push must arrive on THIS stream: the dispatch ran in the
      // Vite-loaded runtime whose SSE registry holds the connection. A
      // natively-imported dispatchToApp would commit but reach nobody.
      const buf = await readUntil((t) => /"value":"4"/.test(t))
      expect(buf).toContain('"value":"4"')
    } finally {
      abort.abort()
      reader.cancel().catch(() => {})
      void pump
    }
  })

  it('serves a data GET route as JSON through the Vite loader', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })

    const before = await app.fetch(new Request('http://localhost/api-tally'))
    expect(before.status).toBe(200)
    expect(before.headers.get('content-type')).toContain('application/json')
    const { total: t0 } = (await before.json()) as { total: number }

    await app.dispatchToApp(Tally, { type: 'BUMP', by: 2 })

    const after = await app.fetch(new Request('http://localhost/api-tally'))
    expect(((await after.json()) as { total: number }).total).toBe(t0 + 2)
  })

  it('a param segment with an extension suffix routes beside its bare-param page', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })

    const data = await app.fetch(new Request('http://localhost/pp/abc.json'))
    expect(data.status).toBe(200)
    expect(data.headers.get('content-type')).toContain('application/json')
    expect(await data.json()).toEqual({ id: 'abc' })

    // A dotted id still resolves: capture is lazy up to the literal suffix.
    const dotted = await app.fetch(new Request('http://localhost/pp/a.b.json'))
    expect(await dotted.json()).toEqual({ id: 'a.b' })

    // The bare-param PAGE still owns the suffix-less URL — the data route
    // outranks it only for .json requests.
    const page = await app.fetch(new Request('http://localhost/pp/abc'))
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('page abc')
  })

  it('live-reloads a template edit without a restart', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })
    const file = resolve(root, 'templates/page.stator')
    const original = await readFile(file, 'utf8')
    try {
      const before = await (await app.fetch(new Request('http://localhost/'))).text()
      expect(before).toMatch(/<title[^>]*>dev-app<\/title>/)

      // Edit the template on disk; the watcher should rebuild the app graph.
      await writeFile(
        file,
        original.replace('<title>dev-app</title>', '<title>edited-live</title>'),
      )

      // Poll until the rebuilt app serves the change (chokidar + rebuild are async).
      let after = ''
      for (let i = 0; i < 60; i++) {
        after = await (await app.fetch(new Request('http://localhost/'))).text()
        if (/edited-live/.test(after)) break
        await new Promise((r) => setTimeout(r, 150))
      }
      expect(after).toMatch(/<title[^>]*>edited-live<\/title>/)
    } finally {
      await writeFile(file, original)
    }
  })
})
