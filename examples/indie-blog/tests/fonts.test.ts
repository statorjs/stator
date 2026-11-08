import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const PORT = 3908
process.env.INDIE_BLOG_DB = join(mkdtempSync(join(tmpdir(), 'indie-fonts-')), 'test.db')
process.env.INDIE_BLOG_ORIGIN = `http://localhost:${PORT}`

const here = dirname(fileURLToPath(import.meta.url))
let app: import('@statorjs/stator/dev').DevApp

before(async () => {
  // The synced font files are gitignored — a fresh checkout runs the sync via
  // predev/prebuild; tests do it themselves.
  execFileSync('node', [resolve(here, '../scripts/sync-fonts.mjs')])
  const { createDevApp } = await import('@statorjs/stator/dev')
  app = await createDevApp({
    root: resolve(here, '..'),
    machinesDir: resolve(here, '../machines'),
    routesDir: resolve(here, '../routes'),
    staticDir: resolve(here, '../static'),
  })
}, { timeout: 30_000 })

after(async () => {
  await app?.close()
})

describe('self-hosted webfont', () => {
  it('the layout preloads the primary face with crossorigin', async () => {
    const html = await (await app.fetch(new Request(`http://localhost:${PORT}/`))).text()
    assert.ok(html.includes('rel="preload"'))
    assert.ok(html.includes('/static/fonts/literata-latin-wght-normal.woff2'))
    assert.match(html, /as="font"[^>]*crossorigin/)
  })

  it('serves the synced woff2 with the right type and a revalidator', async () => {
    const res = await app.fetch(
      new Request(`http://localhost:${PORT}/static/fonts/literata-latin-wght-normal.woff2`),
    )
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'font/woff2')
    assert.ok(res.headers.get('etag'))
  })
})
