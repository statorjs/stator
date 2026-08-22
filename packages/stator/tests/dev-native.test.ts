import { type ChildProcess, spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The native (Vite-free) dev server, exercised the way a user runs it: the
 * `stator` CLI with `STATOR_NATIVE_DEV=1` against the same fixture app the
 * Vite-backed dev server tests use. A subprocess rather than an in-process
 * `createNativeDevApp`, because the native server loads app modules through
 * Node's loader hooks and vitest's module runner intercepts `import()` — the
 * hooks would never see a thing.
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

beforeAll(async () => {
  const port = 52000 + (process.pid % 3000)
  child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      STATOR_NATIVE_DEV: '1',
      STATOR_FIXTURE_BOOT_BUMP: '1',
      LOG_LEVEL: 'warn',
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
}, 40_000)

afterAll(() => {
  child?.kill()
})

describe('native dev server: .stator end to end, no Vite', () => {
  it('renders a .stator route with scoped CSS (production head shape) and patches events', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    const html = await res.text()

    expect(html).toContain('count is 0')
    const m = html.match(/data-s-([0-9a-f]{8})/)
    expect(m).toBeTruthy()
    const hash = m![1]
    // Scoped CSS is linked exactly as in production, served from memory.
    expect(html).toContain('<link rel="stylesheet" href="/static/components.css">')
    const cssRes = await get('/static/components.css')
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get('content-type')).toContain('text/css')
    const css = await cssRes.text()
    expect(css).toContain(`.label[data-s-${hash}]`)
    expect(css).toContain('rebeccapurple')

    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    const post = await get('/__events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /', Cookie: cookie },
      body: JSON.stringify({ machine: 'CounterMachine', event: { type: 'INCREMENT' } }),
    })
    expect(post.status).toBe(200)
    const json = (await post.json()) as { patches: Array<{ op: string; value?: string }> }
    expect(json.patches.some((p) => p.value === 'count is 1')).toBe(true)
  })

  it('passes a raw Response from an api route through verbatim', async () => {
    const res = await get('/raw-response', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, marker: 'raw-passthrough' })
  })

  it('renders a client component shell and serves its bundled module script', async () => {
    const html = await (await get('/')).text()
    expect(html).toContain('<tick-counter')
    expect(html).toContain('data-b="b0"')
    expect(html).not.toContain('on:click')
    // Bundled through the seam to a hashed asset on the production URL shape.
    const m = html.match(
      /<script type="module" src="(\/static\/assets\/templates_tick-counter-[\w-]+\.js)"><\/script>/,
    )
    expect(m).toBeTruthy()
    const asset = await get(m![1]!)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect(await asset.text()).toContain('tick-counter')
    // A route that reaches no island gets no island script.
    const api = await (await get('/tally')).text()
    expect(api).not.toContain('/static/assets/')
  })

  it('stubs a server-machine import in the island bundle but renders with the whole machine', async () => {
    const html = await (await get('/remote')).text()
    // SSR used the real machine (its selector ran).
    expect(html).toContain('count is 0')
    const m = html.match(/src="(\/static\/assets\/templates_counter-remote-[\w-]+\.js)"/)
    expect(m).toBeTruthy()
    const code = await (await get(m![1]!)).text()
    // The browser bundle carries the identity stub only — never the body.
    expect(code).toContain('CounterMachine')
    expect(code).not.toContain('count is')
    expect(code).not.toContain('selectors')
  })

  it('emits a URL-referenced .wasm as a hashed asset and serves it as application/wasm', async () => {
    const html = await (await get('/wasm')).text()
    const script = /src="(\/static\/assets\/templates_wasm-probe-[\w-]+\.js)"/.exec(html)?.[1]
    expect(script).toBeTruthy()
    const code = await (await get(script!)).text()
    // `new URL('./probe.wasm', import.meta.url)` → hashed asset URL in the bundle.
    const wasm = /\/static\/assets\/probe-[\w-]+\.wasm/.exec(code)?.[0]
    expect(wasm).toBeTruthy()
    const res = await get(wasm!)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/wasm')
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    )
  })

  it('runs app modules from the source tree — import.meta.url is truthful', async () => {
    const res = await get('/where.json')
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(url.startsWith(pathToFileURL(resolve(root, 'routes')).href)).toBe(true)
    expect(url).not.toContain('.stator-dev')
  })

  it('injects the dev reload client (replacing Vite HMR) and the inspector', async () => {
    const html = await (await get('/')).text()
    expect(html).toContain("new EventSource('/__stator_dev')")
    expect(html).not.toContain('/@vite/client')
    expect(html).toContain('<script src="/@stator/inspector.js" defer></script>')
    const asset = await get('/@stator/inspector.js')
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('stator-inspector')
  })

  it('boot-originated dispatchToApp fans out to a live SSE connection', async () => {
    // The fixture's boot.ts BUMPs the app tally every 200 ms (env-gated). Open
    // the live route's stream and expect a push: the dispatch and the SSE
    // registry must share one module instance — the property the Vite fence
    // broke, and the one the native server has by construction.
    const page = await get('/tally')
    expect(page.status).toBe(200)
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!
    const abort = new AbortController()
    const res = await get(`/__sse?route=${encodeURIComponent('GET /tally')}`, {
      headers: { Cookie: cookie },
      signal: abort.signal,
    })
    expect(res.status).toBe(200)
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
      expect(buffer).toContain(': open')
      const total = Number(pushed.exec(buffer)?.[1])
      expect(total).toBeGreaterThanOrEqual(4)
      expect(total % 4).toBe(0)
    } finally {
      abort.abort()
      reader.cancel().catch(() => {})
      void pump
    }
  }, 15_000)

  it('serves a data GET route as JSON', async () => {
    const res = await get('/api-tally')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(typeof ((await res.json()) as { total: number }).total).toBe('number')
  })

  it('a param segment with an extension suffix routes beside its bare-param page', async () => {
    const data = await get('/pp/abc.json')
    expect(data.status).toBe(200)
    expect(await data.json()).toEqual({ id: 'abc' })
    const page = await get('/pp/abc')
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('page abc')
  })

  it('live-reloads a template edit without a restart', async () => {
    // Edits `remote-page.stator`, not `page.stator`: the Vite dev-server test
    // live-edits the latter and vitest runs files in parallel on this fixture.
    const file = resolve(root, 'templates/remote-page.stator')
    const original = await readFile(file, 'utf8')
    try {
      expect(await titleOf('/remote')).toBe('remote')
      await writeFile(file, original.replace('<title>remote</title>', '<title>edited-live</title>'))
      expect(await settleTitle('/remote', 'edited-live')).toBe(true)
    } finally {
      await writeFile(file, original)
      await settleTitle('/remote', 'remote')
    }
  }, 20_000)

  it('re-evaluates only the changed module and its importers', async () => {
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
      expect(await settleTitle('/remote', 'lib-untouched')).toBe(true)
      expect(await id()).toBe(first)
    } finally {
      await writeFile(page, pageOriginal)
      await settleTitle('/remote', 'remote')
    }
    expect(await id()).toBe(first)

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
      expect(after).not.toBe(first)
    } finally {
      await writeFile(lib, libOriginal)
      await sleep(500)
    }
  }, 30_000)
})
