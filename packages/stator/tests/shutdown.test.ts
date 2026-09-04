import { type ChildProcess, spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { drainAndClose, shutdownTimeoutMs } from '../src/server/shutdown.ts'

/**
 * Graceful shutdown with live connections open.
 *
 * `server.close()` resolves only once every connection has ended, so a single
 * open SSE response used to wedge SIGTERM until the platform SIGKILLed the
 * process (systemd's default `TimeoutStopSec` is 90 seconds). The first test
 * here is the regression: the CLI, a real live connection, a real signal.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/dev-app')
const bin = resolve(here, '../src/cli/stator.js')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let child: ChildProcess | undefined
let extra: Server | undefined

afterEach(() => {
  child?.kill('SIGKILL')
  child = undefined
  extra?.close()
  extra = undefined
})

describe('shutdown: SIGTERM with a live connection open', () => {
  it('closes the stream and exits 0 instead of hanging', async () => {
    const port = 55000 + (process.pid % 2000)
    child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], {
      cwd: root,
      // The fixture's boot.ts ticks a 200ms dispatch under this flag, so the
      // drain runs against an app that is actively fanning out.
      env: { ...process.env, STATOR_FIXTURE_BOOT_BUMP: '1', LOG_LEVEL: 'warn', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let bound = 0
    child.stdout!.on('data', (b) => {
      const m = /localhost:(\d+)/.exec(String(b))
      if (m) bound = Number(m[1])
    })
    for (let i = 0; i < 100 && !bound; i++) await sleep(100)
    expect(bound, 'dev server bound a port').toBeGreaterThan(0)

    // A real event-stream, held open exactly as a live page holds one.
    const abort = new AbortController()
    const stream = await fetch(
      `http://localhost:${bound}/__sse?route=${encodeURIComponent('GET /tally')}&client=shutdown-test`,
      {
        signal: abort.signal,
        headers: { accept: 'text/event-stream' },
      },
    )
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    void (async () => {
      try {
        while (true) if ((await reader.read()).done) break
      } catch {
        // The server hanging up mid-read is the expected end.
      }
    })()
    await sleep(300)

    const started = Date.now()
    const exit = new Promise<{ code: number | null; ms: number }>((done) =>
      child!.once('exit', (code) => done({ code, ms: Date.now() - started })),
    )
    child.kill('SIGTERM')
    const outcome = await Promise.race([exit, sleep(8000).then(() => 'hung' as const)])
    abort.abort()

    expect(outcome, 'SIGTERM must not wait on the live connection').not.toBe('hung')
    const { code, ms } = outcome as { code: number | null; ms: number }
    // Exit 0: a signal is a normal stop, not a failure. Well under the 5s
    // in-flight deadline, because hanging up the stream is immediate.
    expect(code).toBe(0)
    expect(ms).toBeLessThan(3000)
  }, 30_000)
})

describe('shutdown: drainAndClose', () => {
  it('destroys sockets still working when the deadline expires', async () => {
    // A request that never responds — the case the deadline exists for.
    const server = createServer(() => {})
    extra = server
    await new Promise<void>((done) => server.listen(0, () => done()))
    const { port } = server.address() as { port: number }

    const abort = new AbortController()
    const hanging = fetch(`http://localhost:${port}/`, { signal: abort.signal }).catch(() => 'gone')
    await sleep(100)

    const started = Date.now()
    const result = await drainAndClose(server, { timeoutMs: 300 })
    const elapsed = Date.now() - started

    expect(result.forced).toBe(true)
    expect(result.connections).toBe(0)
    expect(elapsed).toBeLessThan(2000)
    abort.abort()
    await hanging
  })

  it('reports a clean drain when nothing is in flight', async () => {
    const server = createServer((_req, res) => res.end('ok'))
    extra = server
    await new Promise<void>((done) => server.listen(0, () => done()))
    const { port } = server.address() as { port: number }
    await (await fetch(`http://localhost:${port}/`)).text()

    const result = await drainAndClose(server, { timeoutMs: 5000 })
    expect(result).toEqual({ connections: 0, forced: false })
  })

  it('runs teardown before closing, and survives one that throws', async () => {
    const server = createServer((_req, res) => res.end('ok'))
    extra = server
    await new Promise<void>((done) => server.listen(0, () => done()))

    let ran = false
    const result = await drainAndClose(server, {
      timeoutMs: 5000,
      teardown: () => {
        ran = true
        throw new Error('teardown blew up')
      },
    })
    expect(ran).toBe(true)
    expect(result.forced).toBe(false)
  })
})

describe('shutdown: STATOR_SHUTDOWN_TIMEOUT_MS', () => {
  const original = process.env.STATOR_SHUTDOWN_TIMEOUT_MS
  afterEach(() => {
    if (original === undefined) delete process.env.STATOR_SHUTDOWN_TIMEOUT_MS
    else process.env.STATOR_SHUTDOWN_TIMEOUT_MS = original
  })

  it('defaults to 5s, reads the env var, and ignores nonsense', () => {
    delete process.env.STATOR_SHUTDOWN_TIMEOUT_MS
    expect(shutdownTimeoutMs()).toBe(5000)
    process.env.STATOR_SHUTDOWN_TIMEOUT_MS = '30000'
    expect(shutdownTimeoutMs()).toBe(30_000)
    process.env.STATOR_SHUTDOWN_TIMEOUT_MS = '0'
    expect(shutdownTimeoutMs()).toBe(0)
    process.env.STATOR_SHUTDOWN_TIMEOUT_MS = 'soon'
    expect(shutdownTimeoutMs()).toBe(5000)
    process.env.STATOR_SHUTDOWN_TIMEOUT_MS = '-1'
    expect(shutdownTimeoutMs()).toBe(5000)
  })
})
