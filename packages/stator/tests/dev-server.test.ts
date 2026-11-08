import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createDevApp, type DevApp, withDeprecatedVite } from '../src/server/dev.ts'
import Tally from './fixtures/dev-app/machines/tally.ts'

/**
 * The TRANSITIONAL Vite-embedded dev server (`createDevApp` boots the native
 * server by default since the Vite exit — see dev-native.test.ts). This suite
 * pins the escape hatch via STATOR_VITE_DEV=1, exercising both the dispatch in
 * `createDevApp` and the Vite implementation behind it: a `.stator` template,
 * compiled by Vite, rendered through the real runtime — scoped HTML,
 * SSR-injected scoped CSS in <head>, and correct event patches. Deleted with
 * the Vite implementation when the hatch retires.
 */
process.env.STATOR_VITE_DEV = '1'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/dev-app')

let app: DevApp | undefined
after(async () => {
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
    assert.equal(res.status, 200)
    const html = await res.text()

    // Template rendered through the runtime.
    assert.ok(html.includes('count is 0'))
    // Scope attribute injected on elements (style block present → scoping on).
    const m = html.match(/data-s-([0-9a-f]{8})/)
    assert.ok(m)
    const hash = m![1]
    // Scoped CSS injected into <head>.
    assert.ok(html.includes('<style data-stator-dev>'))
    assert.ok(html.includes(`.label[data-s-${hash}]`))
    assert.ok(html.includes('rebeccapurple'))

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
    assert.equal(post.status, 200)
    const json = (await post.json()) as {
      patches: Array<{ op: string; value?: string }>
    }
    assert.equal(
      json.patches.some((p) => p.value === 'count is 1'),
      true,
    )
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
    assert.equal(res.status, 200)
    assert.deepStrictEqual(await res.json(), { ok: true, marker: 'raw-passthrough' })
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
    assert.ok(html.includes('<tick-counter'))
    assert.ok(html.includes('data-b="b0"'))
    assert.ok(!html.includes('on:click'))
    // Its client module script is injected (served by Vite at the ?type=client URL).
    assert.match(
      html,
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
    // (`vite` is non-null here — the escape hatch returns the real server.)
    const browser = await app.vite!.transformRequest('/machines/counter.ts')
    assert.ok(browser?.code?.includes('CounterMachine'))
    assert.ok(!browser?.code?.includes('INCREMENT'))

    // SSR-plane transform: the real module, untouched.
    const ssr = await app.vite!.transformRequest('/machines/counter.ts', { ssr: true })
    assert.ok(ssr?.code?.includes('INCREMENT'))
  })

  it('injects the Vite HMR client so the browser can receive reload signals', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })
    const html = await (await app.fetch(new Request('http://localhost/'))).text()
    assert.ok(html.includes('<script type="module" src="/@vite/client"></script>'))
  })

  it('auto-injects and serves the dev inspector', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })
    const html = await (await app.fetch(new Request('http://localhost/'))).text()
    assert.ok(html.includes('<script src="/@stator/inspector.js" defer></script>'))

    const asset = await app.fetch(new Request('http://localhost/@stator/inspector.js'))
    assert.equal(asset.status, 200)
    assert.ok(asset.headers.get('Content-Type')?.includes('javascript'))
    assert.ok((await asset.text()).includes('stator-inspector'))
  })

  it('serves machine-state inspection at /@stator/inspect (hatch parity)', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })
    const res = await app.fetch(new Request('http://localhost/@stator/inspect'))
    assert.equal(res.status, 200)
    const payload = (await res.json()) as { machines: Array<{ name: string }> }
    assert.ok(payload.machines.map((m) => m.name).includes('CounterMachine'))
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
      assert.ok(!html.includes('/@stator/inspector.js'))
      const asset = await noInspector.fetch(new Request('http://localhost/@stator/inspector.js'))
      assert.equal(asset.status, 404)
    } finally {
      await noInspector.close()
    }
  })

  it('never watches an in-project package store or other dot directories', async () => {
    // pnpm puts its store inside the project when the project sits on its own
    // filesystem (a CI container). Watched file by file, it exhausted the
    // host's inotify watches.
    const store = resolve(root, '.pnpm-store/v10/files/00')
    await mkdir(store, { recursive: true })
    await writeFile(resolve(store, 'pkg.json'), '{}')
    const watched = await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })
    try {
      const dirs = Object.keys(watched.vite!.watcher.getWatched())
      assert.equal(
        dirs.some((d) => d.includes('.pnpm-store')),
        false,
      )
      // App source is still watched.
      assert.equal(
        dirs.some((d) => d.endsWith('/routes')),
        true,
      )
    } finally {
      await watched.close()
      await rm(resolve(root, '.pnpm-store'), { recursive: true, force: true })
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
    assert.equal(page.status, 200)
    // Lazy sessions: the app-machine page sets no cookie; mint a sid.
    const cookie = `stator_sid=${crypto.randomUUID()}`

    const abort = new AbortController()
    const res = await app.fetch(
      new Request(`http://localhost/__sse?route=${encodeURIComponent('GET /tally')}`, {
        headers: { Cookie: cookie },
        signal: abort.signal,
      }),
    )
    assert.equal(res.status, 200)
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
      const deadline = Date.now() + 15_000
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
      assert.equal(result.committed, true)

      // The push must arrive on THIS stream: the dispatch ran in the
      // Vite-loaded runtime whose SSE registry holds the connection. A
      // natively-imported dispatchToApp would commit but reach nobody.
      const buf = await readUntil((t) => /"value":"4"/.test(t))
      assert.ok(buf.includes('"value":"4"'))
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
    assert.equal(before.status, 200)
    assert.ok(before.headers.get('content-type')?.includes('application/json'))
    const { total: t0 } = (await before.json()) as { total: number }

    await app.dispatchToApp(Tally, { type: 'BUMP', by: 2 })

    const after = await app.fetch(new Request('http://localhost/api-tally'))
    assert.equal(((await after.json()) as { total: number }).total, t0 + 2)
  })

  it('a param segment with an extension suffix routes beside its bare-param page', async () => {
    app ??= await createDevApp({
      root,
      machinesDir: resolve(root, 'machines'),
      routesDir: resolve(root, 'routes'),
    })

    const data = await app.fetch(new Request('http://localhost/pp/abc.json'))
    assert.equal(data.status, 200)
    assert.ok(data.headers.get('content-type')?.includes('application/json'))
    assert.deepStrictEqual(await data.json(), { id: 'abc' })

    // A dotted id still resolves: capture is lazy up to the literal suffix.
    const dotted = await app.fetch(new Request('http://localhost/pp/a.b.json'))
    assert.deepStrictEqual(await dotted.json(), { id: 'a.b' })

    // The bare-param PAGE still owns the suffix-less URL — the data route
    // outranks it only for .json requests.
    const page = await app.fetch(new Request('http://localhost/pp/abc'))
    assert.ok(page.headers.get('content-type')?.includes('text/html'))
    assert.ok((await page.text()).includes('page abc'))
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
      assert.match(before, /<title[^>]*>dev-app<\/title>/)

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
      assert.match(after, /<title[^>]*>edited-live<\/title>/)
    } finally {
      await writeFile(file, original)
    }
  })
})

describe('dev server: session carry-over across store rebuilds', () => {
  // Own fixture, deliberately: this suite's dev app AND the dev-native
  // subprocess suite both watch fixtures/dev-app, so a persistence assertion
  // there would race the other suite's machine edits.
  it("a machine-closure edit that doesn't change code keeps sessions", {
    timeout: 30_000,
  }, async () => {
    const coRoot = resolve(here, 'fixtures/dev-carryover')
    const coApp = await createDevApp({
      root: coRoot,
      machinesDir: resolve(coRoot, 'machines'),
      routesDir: resolve(coRoot, 'routes'),
    })
    const lib = resolve(coRoot, 'lib/step.ts')
    const original = await readFile(lib, 'utf8')
    try {
      const res = await coApp.fetch(new Request('http://localhost/'))
      const cookie = res.headers.get('set-cookie')!.split(';')[0]!
      await coApp.fetch(
        new Request('http://localhost/__events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Stator-Route': 'GET /',
            Cookie: cookie,
          },
          body: JSON.stringify({ machine: 'CarryCounterMachine', event: { type: 'INCREMENT' } }),
        }),
      )
      const at1 = await (
        await coApp.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
      ).text()
      assert.ok(at1.includes('count is 1'))

      // Append a comment to a file in the machine's closure: the store IS
      // rebuilt, but the code hash is unchanged (the hash ignores comments), so
      // the session must survive. Guards the one-session-store-per-process
      // invariant — recreating the default store on rebuild reset everything.
      const before = coApp.hono
      await writeFile(lib, `${original}// carry-over probe\n`)
      // The rebuild swaps the Hono app; the swap is the completion signal.
      for (let i = 0; i < 100 && coApp.hono === before; i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.notEqual(coApp.hono, before)

      const after = await (
        await coApp.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
      ).text()
      assert.ok(after.includes('count is 1'))
    } finally {
      await writeFile(lib, original)
      await coApp.close()
    }
  })
})

describe('createDevApp dispatch (the Vite exit surface)', () => {
  it('withDeprecatedVite exposes vite as undefined with a one-time warning', () => {
    const fake = {
      fetch: () => new Response('ok'),
      hono: {} as never,
      dispatchToApp: async () => ({ committed: true }),
      listen: async () => {},
      close: async () => {},
    }
    const warnings: unknown[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args)
    try {
      const wrapped = withDeprecatedVite(fake)
      assert.equal(wrapped.vite, undefined)
      assert.equal(wrapped.vite, undefined)
      assert.equal(warnings.length, 1)
      assert.ok(String(warnings[0]).includes('deprecated'))
    } finally {
      console.warn = original
    }
  })
})

describe('dev server: a user vite.config is ignored (dev/prod parity)', () => {
  it('boots even when the app root has a throwing vite.config.ts', async () => {
    // The fixture's vite.config.ts throws if evaluated. `createDevApp` sets
    // `configFile: false` (matching `stator build`), so it's never read and the
    // dev server boots — a user vite.config can't take effect in dev, just as it
    // never did in prod. A regression would reject here with STRAY_VITE_CONFIG.
    const cfgRoot = resolve(here, 'fixtures/dev-vite-config')
    let cfgApp: DevApp | undefined
    try {
      cfgApp = await createDevApp({
        root: cfgRoot,
        machinesDir: resolve(cfgRoot, 'machines'),
        routesDir: resolve(cfgRoot, 'routes'),
      })
      const res = await cfgApp.fetch(new Request('http://localhost/'))
      assert.equal(res.status, 200)
      assert.ok((await res.text()).includes('ok'))
    } finally {
      await cfgApp?.close()
    }
  })
})
