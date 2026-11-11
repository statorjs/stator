import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, it, mock } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createApp, type StatorApp } from '../src/server/create-app.ts'

/**
 * `listen()` and `close()` on the production app. A caller that starts a
 * server can stop it: the port is released, boot work is torn down, and
 * nothing is left holding the process open. `listen(0)` takes whatever port
 * the OS has free and says which.
 */

const here = dirname(fileURLToPath(import.meta.url))
const probe = resolve(here, 'fixtures/sse-probe')

const boot = (extra: Record<string, unknown> = {}): Promise<StatorApp> =>
  createApp({
    machinesDir: resolve(probe, 'machines'),
    routesDir: resolve(probe, 'routes'),
    ...extra,
  })

const servers = (): number =>
  (process as unknown as { _getActiveHandles(): object[] })
    ._getActiveHandles()
    .filter((h) => h.constructor.name === 'Server').length

let app: StatorApp | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
  mock.restoreAll()
})

/** Start `app` on a free port, with the startup notice kept off the output. */
async function start(target: StatorApp): Promise<number> {
  const out = mock.method(process.stdout, 'write', () => true)
  const { port } = await target.listen(0)
  out.mock.restore()
  return port
}

describe('StatorApp listen() and close()', () => {
  it('listen(0) resolves with the port the OS chose, and serves on it', async () => {
    app = await boot()
    const port = await start(app)
    assert.ok(port > 0)
    const res = await fetch(`http://localhost:${port}/tally`)
    assert.equal(res.status, 200)
    await res.text()
  })

  it('close() releases the port and leaves no server behind', async () => {
    app = await boot()
    const before = servers()
    const port = await start(app)
    await (await fetch(`http://localhost:${port}/tally`)).text()

    await app.close()
    await assert.rejects(fetch(`http://localhost:${port}/tally`))
    assert.equal(servers(), before)
  })

  it('close() hangs up a live page’s stream rather than waiting on it', async () => {
    app = await boot()
    const port = await start(app)
    const stream = await fetch(
      `http://localhost:${port}/__sse?route=${encodeURIComponent('GET /tally')}`,
    )
    assert.equal(stream.status, 200)
    const reader = stream.body!.getReader()
    await reader.read()

    const started = performance.now()
    await app.close()
    assert.ok(performance.now() - started < 2000)
    // The stream ends, or errors, once the server hangs up.
    await assert.doesNotReject(async () => {
      try {
        while (!(await reader.read()).done) {
          // drain
        }
      } catch {
        // a reset is an end too
      }
    })
  })

  it('close() removes the signal handlers listen() installed', async () => {
    const before = process.listenerCount('SIGTERM')
    app = await boot()
    await start(app)
    assert.equal(process.listenerCount('SIGTERM'), before + 1)
    await app.close()
    assert.equal(process.listenerCount('SIGTERM'), before)
    assert.equal(process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'))
  })

  it('close() runs the boot teardown, once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stator-close-'))
    const file = join(dir, 'boot.ts')
    const counter = join(dir, 'count.mjs')
    writeFileSync(counter, 'export const calls = { boot: 0, teardown: 0 }\n')
    writeFileSync(
      file,
      `import { defineBoot } from '${resolve(here, '../src/server/boot.ts')}'\n` +
        `import { calls } from '${counter}'\n` +
        'export default defineBoot(() => {\n  calls.boot++\n  return () => { calls.teardown++ }\n})\n',
    )
    const { calls } = (await import(pathToFileURL(counter).href)) as {
      calls: { boot: number; teardown: number }
    }
    app = await boot({ bootFile: file })
    await start(app)
    assert.deepEqual(calls, { boot: 1, teardown: 0 })
    await app.close()
    await app.close()
    assert.deepEqual(calls, { boot: 1, teardown: 1 })
  })

  it('an app can listen again after it is closed, and close() before listen() is a no-op', async () => {
    app = await boot()
    await app.close()
    const first = await start(app)
    await app.close()
    const second = await start(app)
    assert.ok(second > 0)
    assert.equal((await fetch(`http://localhost:${second}/tally`)).status, 200)
    assert.ok(first > 0)
  })
})
