import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createDevApp, type DevApp } from '../src/server/dev.ts'
import { isPrunedDevPath } from '../src/server/dev-watch.ts'
import Tally from './fixtures/dev-app/machines/tally.ts'

/**
 * The native dev app, in-process. Node's test runner keeps Node's loader
 * hooks (the register loader is preloaded), so `createDevApp` runs here
 * exactly as `stator dev` runs it; dev-native.test.ts drives the CLI as a
 * subprocess for the behaviours that need a real process (signals, the
 * terminal, reload over a socket).
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/dev-app')
const boot = (extra: Record<string, unknown> = {}) =>
  createDevApp({
    root,
    machinesDir: resolve(root, 'machines'),
    routesDir: resolve(root, 'routes'),
    ...extra,
  })

describe('the native dev app in-process', () => {
  let app: DevApp | undefined
  after(async () => {
    await app?.close()
  })

  it('can disable the inspector via config', async () => {
    const quiet = await boot({ dev: { inspector: false } })
    try {
      const html = await (await quiet.fetch(new Request('http://localhost/'))).text()
      assert.ok(!html.includes('/@stator/inspector.js'))
      assert.equal(
        (await quiet.fetch(new Request('http://localhost/@stator/inspector.js'))).status,
        404,
      )
    } finally {
      await quiet.close()
    }
  })

  it('dispatchToApp commits and fans out to a live SSE connection', {
    timeout: 30_000,
  }, async () => {
    app = await boot()
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
      const deadline = Date.now() + 10_000
      while (!predicate(buffer) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15))
      }
      return predicate(buffer)
    }
    try {
      assert.ok(await readUntil((t) => t.includes(': open')))
      // The def is imported here directly, as a user's boot.ts would; the dev
      // app resolves it by name, so identities never need to match.
      const result = await app.dispatchToApp(Tally, { type: 'BUMP', by: 4 })
      assert.equal(result.committed, true)
      const { total } = (await (
        await app.fetch(new Request('http://localhost/api-tally'))
      ).json()) as {
        total: number
      }
      assert.ok(await readUntil((t) => t.includes(`"value":"${total}"`)), buffer)
    } finally {
      abort.abort()
      reader.cancel().catch(() => {})
      void pump
    }
  })
})

describe('what the dev watcher skips', () => {
  it('skips dependencies, build output, tests and every dot segment, never app source', () => {
    for (const rel of [
      'node_modules/x/a.ts',
      'dist/routes/a.ts',
      'tests/a.test.ts',
      '.git/HEAD',
      '.pnpm-store/v10/files/00/pkg.json',
      'routes/.cache/x',
    ])
      assert.equal(isPrunedDevPath(rel), true, rel)
    for (const rel of ['routes/index.stator', 'machines/cart.ts', 'lib/db.ts', 'static/app.css'])
      assert.equal(isPrunedDevPath(rel), false, rel)
  })
})
