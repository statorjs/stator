import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp, type StatorApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

const boot = (buildId?: string) =>
  createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
    buildId,
  })

const cookieFor = async (app: StatorApp, path: string) =>
  (await app.fetch(new Request(`http://localhost${path}`))).headers
    .get('set-cookie')!
    .split(';')[0]!

/** Open /__sse and read the first chunk of the stream (enough to see the reload
 *  directive or the `: open` handshake), then abort. */
async function sseFirstChunk(
  app: StatorApp,
  routeKey: string,
  cookie: string,
  build?: string,
): Promise<string> {
  const abort = new AbortController()
  const buildParam = build ? `&build=${encodeURIComponent(build)}` : ''
  const url = `http://localhost/__sse?route=${encodeURIComponent(routeKey)}${buildParam}`
  const res = await app.fetch(
    new Request(url, { headers: { Cookie: cookie }, signal: abort.signal }),
  )
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 2000
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // The reload path sends the directive and closes; the normal path writes
      // `: open` then holds. Either is enough to decide.
      if (buffer.includes('reload') || buffer.includes(': open')) break
    }
  } finally {
    abort.abort()
    reader.cancel().catch(() => {})
  }
  return buffer
}

describe('build-id reload handshake', () => {
  it('emits <meta name="stator-build"> on a live page when a build-id is set', async () => {
    const app = await boot('build-A')
    const html = await (await app.fetch(new Request('http://localhost/live-head'))).text()
    expect(html).toContain('<meta name="stator-live" content="true">')
    expect(html).toContain('<meta name="stator-build" content="build-A">')
  })

  it('omits the build meta when no build-id is configured', async () => {
    const app = await boot(undefined)
    const html = await (await app.fetch(new Request('http://localhost/live-head'))).text()
    expect(html).toContain('stator-live')
    expect(html).not.toContain('stator-build')
  })

  it('sends a reload directive when the page build-id is stale', async () => {
    const app = await boot('build-NEW')
    const cookie = await cookieFor(app, '/live-head')
    const buffer = await sseFirstChunk(app, 'GET /live-head', cookie, 'build-OLD')
    expect(buffer).toContain('"reload"')
    expect(buffer).not.toContain(': open') // reload short-circuits before the sync
  })

  it('does NOT reload when the build-id matches', async () => {
    const app = await boot('build-SAME')
    const cookie = await cookieFor(app, '/live-head')
    const buffer = await sseFirstChunk(app, 'GET /live-head', cookie, 'build-SAME')
    expect(buffer).toContain(': open') // normal path
    expect(buffer).not.toContain('reload')
  })

  it('does NOT reload when the client sends no build-id (graceful for old pages)', async () => {
    const app = await boot('build-SAME')
    const cookie = await cookieFor(app, '/live-head')
    const buffer = await sseFirstChunk(app, 'GET /live-head', cookie, undefined)
    expect(buffer).toContain(': open')
    expect(buffer).not.toContain('reload')
  })

  it('does NOT reload when the server has no build-id (even if a client sends one)', async () => {
    const app = await boot(undefined)
    const cookie = await cookieFor(app, '/live-head')
    const buffer = await sseFirstChunk(app, 'GET /live-head', cookie, 'whatever')
    expect(buffer).toContain(': open')
    expect(buffer).not.toContain('reload')
  })
})
