import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * The native (Vite-free) dev server — the default since the Vite exit —
 * exercised the way a user runs it: the `stator` CLI against the same fixture
 * app the transitional Vite dev server tests use. A subprocess rather than an
 * in-process `createDevApp`, because the native server loads app modules
 * through Node's loader hooks and vitest's module runner intercepts
 * `import()` — the hooks would never see a thing.
 *
 * Mirrors `dev-server.test.ts` case for case where the contract is shared
 * (render + scoped CSS + patches, raw Response passthrough, island shell +
 * script, machine stubbing, data GET routes, param+extension routes, live
 * reload) and adds the native-only guarantees: `import.meta.url` is truthful
 * (no mirror), and the dev reload client replaces Vite's HMR client.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/dev-app')
const bin = resolve(here, '../src/cli/stator.js')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let child: ChildProcess | undefined
let base = ''
const output: string[] = []

const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init)
const titleOf = async (path: string) =>
  /<title[^>]*>([^<]*)<\/title>/.exec(await (await get(path)).text())?.[1]
const settleTitle = async (path: string, expected: string) => {
  for (let i = 0; i < 60; i++) {
    if ((await titleOf(path)) === expected) return true
    await sleep(150)
  }
  return false
}

before(
  async () => {
    const port = 52000 + (process.pid % 3000)
    child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], {
      cwd: root,
      env: {
        ...process.env,
        STATOR_FIXTURE_BOOT_BUMP: '1',
        LOG_LEVEL: 'info',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let bound = 0
    child.stdout!.on('data', (b) => {
      const s = String(b)
      output.push(s)
      const m = /localhost:(\d+)/.exec(s)
      if (m) bound = Number(m[1])
    })
    child.stderr!.on('data', (b) => output.push(String(b)))

    // The banner prints the port actually bound (it shifts if `port` is busy).
    const deadline = Date.now() + 30_000
    while (!bound && Date.now() < deadline) await sleep(50)
    if (!bound) throw new Error(`native dev server printed no banner:\n${output.join('')}`)
    base = `http://localhost:${bound}`
    while (Date.now() < deadline) {
      try {
        if ((await get('/')).status === 200) return
      } catch {
        // not listening yet
      }
      await sleep(50)
    }
    throw new Error(`native dev server did not answer:\n${output.join('')}`)
  },
  { timeout: 40_000 },
)

after(() => {
  child?.kill()
})

describe('native dev server: .stator end to end, no Vite', () => {
  it('registers its loaders without a deprecation warning', () => {
    assert.doesNotMatch(output.join(''), /DeprecationWarning|DEP0205/)
  })

  it('renders a .stator route with scoped CSS (production head shape) and patches events', async () => {
    const res = await get('/')
    assert.equal(res.status, 200)
    const html = await res.text()

    assert.ok(html.includes('count is 0'))
    const m = html.match(/data-s-([0-9a-f]{8})/)
    assert.ok(m)
    const hash = m![1]
    // Scoped CSS is linked exactly as in production (the route's own sheet at
    // the build's URL), served from memory.
    const href = /<link rel="stylesheet" href="(\/static\/css\/[^"]+\.css)">/.exec(html)?.[1]
    assert.ok(href, 'the route links its own stylesheet')
    const cssRes = await get(href)
    assert.equal(cssRes.status, 200)
    assert.ok(cssRes.headers.get('content-type'))
    assert.ok(cssRes.headers.get('content-type')!.includes('text/css'))
    const css = await cssRes.text()
    assert.ok(css.includes(`.label[data-s-${hash}]`))
    assert.ok(css.includes('rebeccapurple'))

    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    const post = await get('/__events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /', Cookie: cookie },
      body: JSON.stringify({ machine: 'CounterMachine', event: { type: 'INCREMENT' } }),
    })
    assert.equal(post.status, 200)
    const json = (await post.json()) as { patches: Array<{ op: string; value?: string }> }
    assert.equal(
      json.patches.some((p) => p.value === 'count is 1'),
      true,
    )
  })

  it('passes a raw Response from an api route through verbatim', async () => {
    const res = await get('/raw-response', { method: 'POST' })
    assert.equal(res.status, 200)
    assert.deepStrictEqual(await res.json(), { ok: true, marker: 'raw-passthrough' })
  })

  it('renders a client component shell and serves its bundled module script', async () => {
    const html = await (await get('/')).text()
    assert.ok(html.includes('<tick-counter'))
    assert.ok(html.includes('data-b="b0"'))
    assert.ok(!html.includes('on:click'))
    // Bundled through the seam to a hashed asset on the production URL shape.
    const m = html.match(
      /<script type="module" src="(\/static\/assets\/templates_tick-counter-[\w-]+\.js)"><\/script>/,
    )
    assert.ok(m)
    const asset = await get(m![1]!)
    assert.equal(asset.status, 200)
    assert.ok(asset.headers.get('content-type'))
    assert.ok(asset.headers.get('content-type')!.includes('javascript'))
    const code = await asset.text()
    assert.ok(code.includes('tick-counter'))
    // Dev bundles carry an INLINE sourcemap (browser devtools show island
    // source; the in-memory bundle stays self-contained). Prod bundles don't.
    assert.ok(code.includes('sourceMappingURL=data:application/json'))
    // A route that reaches no island gets no island script.
    const api = await (await get('/tally')).text()
    assert.ok(!api.includes('/static/assets/'))
  })

  it('applies sourcemaps to server stack traces (the CLI opts the process in)', async () => {
    const res = await get('/maps.json')
    assert.equal(res.status, 200)
    assert.deepStrictEqual(await res.json(), { enabled: true })
  })

  it('stubs a server-machine import in the island bundle but renders with the whole machine', async () => {
    const html = await (await get('/remote')).text()
    // SSR used the real machine (its selector ran).
    assert.ok(html.includes('count is 0'))
    const m = html.match(/src="(\/static\/assets\/templates_counter-remote-[\w-]+\.js)"/)
    assert.ok(m)
    const code = await (await get(m![1]!)).text()
    // The browser bundle carries the identity stub only — never the body.
    assert.ok(code.includes('CounterMachine'))
    assert.ok(!code.includes('count is'))
    assert.ok(!code.includes('selectors'))
  })

  it('emits a URL-referenced .wasm as a hashed asset and serves it as application/wasm', async () => {
    const html = await (await get('/wasm')).text()
    const script = /src="(\/static\/assets\/templates_wasm-probe-[\w-]+\.js)"/.exec(html)?.[1]
    assert.ok(script)
    const code = await (await get(script!)).text()
    // `new URL('./probe.wasm', import.meta.url)` → hashed asset URL in the bundle.
    const wasm = /\/static\/assets\/probe-[\w-]+\.wasm/.exec(code)?.[0]
    assert.ok(wasm)
    const res = await get(wasm!)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/wasm')
    assert.deepStrictEqual(
      new Uint8Array(await res.arrayBuffer()).slice(0, 4),
      new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    )
  })

  it('runs app modules from the source tree — import.meta.url is truthful', async () => {
    const res = await get('/where.json')
    assert.equal(res.status, 200)
    const { url } = (await res.json()) as { url: string }
    assert.equal(url.startsWith(pathToFileURL(resolve(root, 'routes')).href), true)
    assert.ok(!url.includes('.stator-dev'))
  })

  it('injects the dev reload client (replacing Vite HMR) and the inspector', async () => {
    const html = await (await get('/')).text()
    assert.ok(html.includes("new EventSource('/__stator_dev')"))
    assert.ok(!html.includes('/@vite/client'))
    assert.ok(html.includes('<script src="/@stator/inspector.js" defer></script>'))
    const asset = await get('/@stator/inspector.js')
    assert.equal(asset.status, 200)
    assert.ok((await asset.text()).includes('stator-inspector'))
  })

  it('opens no second event-stream on a live page — dev signals ride /__sse', async () => {
    // Two streams per tab is what wedges a dev session at three tabs: the
    // browser's six-per-origin HTTP/1.1 pool is shared across the profile.
    const html = await (await get('/live-head')).text()
    assert.ok(html.includes('<meta name="stator-live" content="true">'))
    assert.ok(!html.includes('/__stator_dev'))
    // It still listens — for the build-error overlay, off the live channel.
    assert.ok(html.includes("addEventListener('stator:live-message'"))
    assert.ok(html.includes('build failed'))
  })

  it('stamps a fresh build id per rebuild so a reconnecting page can detect staleness', {
    timeout: 20_000,
  }, async () => {
    const idOf = async (): Promise<string | undefined> =>
      /<meta name="stator-build" content="([^"]+)">/.exec(
        await (await get('/live-head')).text(),
      )?.[1]
    const first = await idOf()
    assert.ok(first)

    // Same edit target as the live-reload test below — the file this suite
    // owns, since the Vite suite watches the same fixture tree in parallel.
    const file = resolve(root, 'templates/remote-page.stator')
    const original = await readFile(file, 'utf8')
    try {
      await writeFile(file, original.replace('<title>remote</title>', '<title>build-id</title>'))
      assert.equal(await settleTitle('/remote', 'build-id'), true)
      // A per-PROCESS id would answer "same build" here, and a page released
      // while backgrounded would reconnect onto a stale slot map instead of
      // being told to reload.
      assert.notEqual(await idOf(), first)
    } finally {
      await writeFile(file, original)
      await settleTitle('/remote', 'remote')
    }
  })

  it('serves machine-state inspection at /@stator/inspect', async () => {
    const res = await get('/@stator/inspect')
    assert.equal(res.status, 200)
    const payload = (await res.json()) as {
      machines: Array<{ name: string; lifecycle: string; hash?: string }>
      app: Record<string, { value: string[] }>
      routes: Array<{ urlPath: string }>
    }
    const names = payload.machines.map((m) => m.name).sort()
    assert.ok(names.includes('CounterMachine'))
    assert.ok(names.includes('TallyMachine'))
    // App machines are live-snapshotted; hashes come from the running defs.
    assert.ok(payload.app.TallyMachine)
    assert.ok(payload.app.TallyMachine.value.length > 0)
    assert.equal(
      payload.machines.every((m) => typeof m.hash === 'string'),
      true,
    )
    assert.equal(
      payload.routes.some((r) => r.urlPath === '/'),
      true,
    )
  })

  it('boot-originated dispatchToApp fans out to a live SSE connection', {
    timeout: 15_000,
  }, async () => {
    // The fixture's boot.ts BUMPs the app tally every 200 ms (env-gated). Open
    // the live route's stream and expect a push: the dispatch and the SSE
    // registry must share one module instance — the property the Vite fence
    // broke, and the one the native server has by construction.
    const page = await get('/tally')
    assert.equal(page.status, 200)
    // Lazy sessions: the app-machine page sets no cookie; mint a sid.
    const cookie = `stator_sid=${crypto.randomUUID()}`
    const abort = new AbortController()
    const res = await get(`/__sse?route=${encodeURIComponent('GET /tally')}`, {
      headers: { Cookie: cookie },
      signal: abort.signal,
    })
    assert.equal(res.status, 200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // Pump in the background — a read racing a timer would abandon reads and
    // drop the chunks they consume.
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
    try {
      // The first frame may be the connect-time snapshot (possibly still "0"
      // before the first tick) — wait for a non-zero total, i.e. a real push.
      const pushed = /"value":"([1-9]\d*)"/
      const deadline = Date.now() + 5000
      while (!pushed.test(buffer) && Date.now() < deadline) await sleep(50)
      assert.ok(buffer.includes(': open'))
      const total = Number(pushed.exec(buffer)?.[1])
      assert.ok(total >= 4)
      assert.equal(total % 4, 0)
    } finally {
      abort.abort()
      reader.cancel().catch(() => {})
      void pump
    }
  })

  it('serves a data GET route as JSON', async () => {
    const res = await get('/api-tally')
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type'))
    assert.ok(res.headers.get('content-type')!.includes('application/json'))
    assert.equal(typeof ((await res.json()) as { total: number }).total, 'number')
  })

  it('a param segment with an extension suffix routes beside its bare-param page', async () => {
    const data = await get('/pp/abc.json')
    assert.equal(data.status, 200)
    assert.deepStrictEqual(await data.json(), { id: 'abc' })
    const page = await get('/pp/abc')
    assert.ok(page.headers.get('content-type'))
    assert.ok(page.headers.get('content-type')!.includes('text/html'))
    assert.ok((await page.text()).includes('page abc'))
  })

  it('a catch-all captures the multi-segment remainder, matches zero segments, and yields to a static sibling', async () => {
    const deep = await get('/files/2026/08/x.jpg')
    assert.equal(deep.status, 200)
    assert.deepStrictEqual(await deep.json(), { path: '2026/08/x.jpg' })
    const zero = await get('/files')
    assert.equal(zero.status, 200)
    assert.deepStrictEqual(await zero.json(), { path: '' })
    const pinned = await get('/files/pinned')
    assert.deepStrictEqual(await pinned.json(), { pinned: true })
  })

  it('live-reloads a template edit without a restart', { timeout: 20_000 }, async () => {
    // Edits `remote-page.stator`, not `page.stator`: the Vite dev-server test
    // live-edits the latter and vitest runs files in parallel on this fixture.
    const file = resolve(root, 'templates/remote-page.stator')
    const original = await readFile(file, 'utf8')
    try {
      assert.equal(await titleOf('/remote'), 'remote')
      await writeFile(file, original.replace('<title>remote</title>', '<title>edited-live</title>'))
      assert.equal(await settleTitle('/remote', 'edited-live'), true)
    } finally {
      await writeFile(file, original)
      await settleTitle('/remote', 'remote')
    }
  })

  it("an edit to a module a machine imports resets that machine's sessions (hydration policy, live)", {
    timeout: 30_000,
  }, async () => {
    // Session A increments under STEP = 1.
    const page = await get('/')
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!
    const inc = () =>
      get('/__events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /', Cookie: cookie },
        body: JSON.stringify({ machine: 'CounterMachine', event: { type: 'INCREMENT' } }),
      })
    await inc()
    assert.ok(
      (await (await get('/', { headers: { Cookie: cookie } })).text()).includes('count is 1'),
    )

    // Edit lib/counter-step.ts — not under machines/, but in CounterMachine's closure.
    const lib = resolve(root, 'lib/counter-step.ts')
    const original = await readFile(lib, 'utf8')
    const logLen = output.length
    try {
      await writeFile(lib, original.replace('STEP = 1', 'STEP = 2'))
      let html = ''
      for (let i = 0; i < 60; i++) {
        html = await (await get('/', { headers: { Cookie: cookie } })).text()
        if (/count is 0/.test(html)) break
        await sleep(150)
      }
      // Same cookie, fresh machine: the snapshot was written by different code.
      assert.ok(html.includes('count is 0'))
      // …and the new code runs: one increment is now a step of 2.
      await inc()
      assert.ok(
        (await (await get('/', { headers: { Cookie: cookie } })).text()).includes('count is 2'),
      )
      // The dev server said so.
      const log = output.slice(logLen).join('')
      assert.ok(log.includes('machine code changed'))
      assert.ok(log.includes('CounterMachine'))
    } finally {
      await writeFile(lib, original)
      for (let i = 0; i < 60; i++) {
        const html = await (await get('/', { headers: { Cookie: cookie } })).text()
        if (/count is 0/.test(html)) break
        await sleep(150)
      }
    }
  })

  it("a machine-closure edit that doesn't change code keeps sessions (carry over)", {
    timeout: 30_000,
  }, async () => {
    // Session increments to 1.
    const page = await get('/')
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!
    await get('/__events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /', Cookie: cookie },
      body: JSON.stringify({ machine: 'CounterMachine', event: { type: 'INCREMENT' } }),
    })
    assert.ok(
      (await (await get('/', { headers: { Cookie: cookie } })).text()).includes('count is 1'),
    )

    // Append a comment to a file in CounterMachine's closure: the store IS
    // rebuilt (the edit touches a machine), but the code hash is unchanged —
    // the machine-hash contract ignores comments — so sessions must survive.
    // Guards the one-session-store-per-process invariant: recreating the
    // default store on rebuild would reset every session on any machine edit.
    const lib = resolve(root, 'lib/counter-step.ts')
    const original = await readFile(lib, 'utf8')
    const logLen = output.length
    try {
      await writeFile(lib, `${original}// carry-over probe\n`)
      let log = ''
      for (let i = 0; i < 60; i++) {
        log = output.slice(logLen).join('')
        if (log.includes('sessions carry over')) break
        await sleep(150)
      }
      assert.ok(log.includes('no machine code changed — sessions carry over'))
      // Same cookie, same state.
      assert.ok(
        (await (await get('/', { headers: { Cookie: cookie } })).text()).includes('count is 1'),
      )
    } finally {
      await writeFile(lib, original)
      await sleep(500)
    }
  })

  it('re-evaluates only the changed module and its importers', { timeout: 30_000 }, async () => {
    const id = async () => ((await (await get('/instance.json')).json()) as { id: string }).id
    const first = await id()

    // An unrelated template edit reloads the app but must not re-run
    // lib/instance.ts (nothing in its import chain changed).
    const page = resolve(root, 'templates/remote-page.stator')
    const pageOriginal = await readFile(page, 'utf8')
    try {
      await writeFile(
        page,
        pageOriginal.replace('<title>remote</title>', '<title>lib-untouched</title>'),
      )
      assert.equal(await settleTitle('/remote', 'lib-untouched'), true)
      assert.equal(await id(), first)
    } finally {
      await writeFile(page, pageOriginal)
      await settleTitle('/remote', 'remote')
    }
    assert.equal(await id(), first)

    // Editing the module itself re-evaluates it — and the route that imports it.
    const lib = resolve(root, 'lib/instance.ts')
    const libOriginal = await readFile(lib, 'utf8')
    try {
      await writeFile(lib, `${libOriginal}// touched\n`)
      let after = first
      for (let i = 0; i < 60 && after === first; i++) {
        await sleep(150)
        after = await id()
      }
      assert.notEqual(after, first)
    } finally {
      await writeFile(lib, libOriginal)
      await sleep(500)
    }
  })
})
