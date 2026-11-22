import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, type StatorApp } from '../src/server/create-app.ts'

/**
 * A GET that reads claims carries no derived `Cache-Control`, whatever the
 * read returned. The anonymous response of a claims-reading URL is one of
 * several answers for that URL, and `public` would let a shared cache hand
 * it to a signed-in visitor.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/claims-read-caching')

let app: StatorApp
let memberCookie: string

before(async () => {
  app = await createApp({
    machinesDir: resolve(root, 'machines'),
    routesDir: resolve(root, 'routes'),
    middlewareFile: resolve(root, 'middleware.ts'),
    buildId: 'B1',
  })
  const login = await app.fetch(
    new Request('http://localhost/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
      body: new URLSearchParams(),
    }),
  )
  // Establishing and rotating in one request sets two cookies; the last wins.
  const sid = login.headers
    .getSetCookie()
    .map((c) => /stator_sid=([^;]+)/.exec(c)?.[1])
    .filter(Boolean)
    .at(-1)
  memberCookie = `stator_sid=${sid}`
})

const get = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://localhost${path}`, { headers }))

/** The three visitors a claims read can meet. */
const visitors = (): [string, Record<string, string>][] => [
  ['anonymous', {}],
  ['cookied without claims', { Cookie: `stator_sid=${crypto.randomUUID()}` }],
  ['signed in', { Cookie: memberCookie }],
]

type Patch = { op: string; target: { kind: string; id: string }; value?: string }

/** The first `patches` frame of a fresh `/__sse` connection. */
async function initialSync(path: string, cookie: string): Promise<Patch[]> {
  const abort = new AbortController()
  const res = await app.fetch(
    new Request(
      `http://localhost/__sse?route=${encodeURIComponent(`GET ${path}`)}&client=c1&build=B1`,
      { headers: { Cookie: cookie }, signal: abort.signal },
    ),
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
      const frame = /data: (\{"patches".*\})\n/.exec(buffer)
      if (frame) return (JSON.parse(frame[1]!) as { patches: Patch[] }).patches
    }
  } finally {
    abort.abort()
    reader.cancel().catch(() => {})
  }
  throw new Error(`no sync frame: ${buffer}`)
}

/** The id of the text slot inside `<p id="total">`. */
const totalSlot = (html: string): string =>
  /id="total"[^>]*>Total: <span data-slot="([^"]+)"/.exec(html)![1]!

describe('a claims read withdraws derived caching', () => {
  it('the app derives caching for a page that reads nothing', async () => {
    const res = await get('/plain')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('cache-control') ?? '', /public/)
  })

  for (const path of ['/shift', '/when-branch', '/text-only', '/shift-static']) {
    it(`${path} is never marked, for any visitor`, async () => {
      for (const [who, headers] of visitors()) {
        const res = await get(path, headers)
        assert.equal(res.status, 200, who)
        assert.equal(res.headers.get('cache-control'), null, who)
      }
    })
  }

  it('a data route that reads claims is never marked', async () => {
    for (const [who, headers] of visitors()) {
      const res = await get('/me.json', headers)
      assert.deepEqual(await res.json(), { user: who === 'signed in' ? 'u1' : null }, who)
      assert.equal(res.headers.get('cache-control'), null, who)
    }
  })

  it('a claims read in middleware withdraws it from a page that reads nothing', async () => {
    for (const [who, headers] of visitors()) {
      const res = await get('/admitted', headers)
      assert.equal(res.status, 200, who)
      assert.equal(res.headers.get('cache-control'), null, who)
    }
  })

  it('a hand-set Cache-Control on a claims-reading page is kept', async () => {
    const res = await get('/hand-set')
    assert.equal(res.headers.get('cache-control'), 'public, s-maxage=30')
  })
})

describe('why: the anonymous page is not the signed-in page', () => {
  it('the anonymous HTML of /shift and the signed-in initial sync disagree on ids', async () => {
    const anonymous = await (await get('/shift')).text()
    const member = await (await get('/shift', { Cookie: memberCookie })).text()
    // The member arm allocates ids ahead of the shared markup, so the total's
    // slot has a different id in each render.
    assert.notEqual(totalSlot(anonymous), totalSlot(member))

    // The sync is addressed in the signed-in numbering: what it sends to the
    // id the anonymous HTML gave the total is not the total.
    const sync = await initialSync('/shift', memberCookie)
    const total = sync.find((p) => p.op === 'text' && p.target.id === totalSlot(member))
    const stray = sync.find((p) => p.op === 'text' && p.target.id === totalSlot(anonymous))
    assert.equal(total?.value, '7')
    assert.ok(stray, 'the sync addresses the id the anonymous HTML gave the total')
    assert.notEqual(stray.value, '7')
  })
})
