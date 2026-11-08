import assert from 'node:assert/strict'
import { readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/build/build.ts'
import { loadProductionHead } from '../src/build/head.ts'
import { createApp } from '../src/server/create-app.ts'

/**
 * A component reachable only inside an inactive `match`/`when` arm must
 * still have its CSS present in the route's artifact — a live SSE update can
 * activate that arm later with no fresh HTTP request.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/route-css-arm-app')
const outDir = resolve(here, 'fixtures/.tmp-route-css-arm-app-dist')

before(
  async () => {
    await buildApp({ root, outDir })
  },
  { timeout: 30_000 },
)

after(async () => {
  await rm(outDir, { recursive: true, force: true })
})

describe('route-css: an inactive match/when arm', () => {
  it("the route's CSS artifact includes the arm's component even though it didn't render", async () => {
    const css = await readFile(join(outDir, 'static/css/routes/toggle.css'), 'utf8')
    assert.ok(css.includes('.badge'))
    assert.ok(css.includes('color: green'))
  })

  it('confirms the arm really was inactive at render time (the machine starts at "loading")', async () => {
    const { headExtras, buildId, machines } = await loadProductionHead(outDir)
    const app = await createApp({
      machinesDir: join(outDir, 'machines'),
      routesDir: join(outDir, 'routes'),
      headExtras,
      buildId,
      machineHashes: machines,
    })
    const res = await app.fetch(new Request('http://localhost/toggle'))
    const html = await res.text()
    assert.ok(!html.includes('Ready'))
    assert.ok(html.includes('Loading'))
    assert.match(html, /<link rel="stylesheet" href="\/static\/css\/routes\/toggle\.css">/)
  })

  it('sanity check: the stylesheet file this test depends on actually exists', async () => {
    assert.notEqual(await stat(join(outDir, 'static/css/routes/toggle.css')), undefined)
  })
})
