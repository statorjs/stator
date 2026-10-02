import { readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/build/build.ts'
import { loadProductionHead } from '../src/build/head.ts'
import { createApp } from '../src/server/create-app.ts'

/**
 * The live-update correctness constraint from the
 * `stator-component-libraries-publish-time-compile-per-component-scoped-css-usage-driven-aggregation`
 * spec: a component reachable only inside an inactive `match`/`when` arm must
 * still have its CSS present in the route's artifact, because a live SSE
 * update can activate that arm later with no fresh HTTP request
 * (`conditional-arm-interiors-are-second-class-on-the-live-update-path`,
 * shipped). `routeCssMap` is static-reachability-based by construction — it
 * scans import specifiers, never renders anything — so this is correct
 * today. This test exists to keep it that way: it builds a route whose
 * machine starts in the state that does NOT render the styled component, and
 * proves the component's CSS is in the artifact anyway.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/route-css-arm-app')
const outDir = resolve(here, 'fixtures/.tmp-route-css-arm-app-dist')

beforeAll(async () => {
  await buildApp({ root, outDir })
}, 30_000)

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true })
})

describe('route-css: an inactive match/when arm', () => {
  it("the route's CSS artifact includes the arm's component even though it didn't render", async () => {
    const css = await readFile(join(outDir, 'static/css/routes/toggle.css'), 'utf8')
    expect(css).toContain('.badge')
    expect(css).toContain('color: green')
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
    // The "ready" branch (and its Badge component) never rendered...
    expect(html).not.toContain('Ready')
    expect(html).toContain('Loading')
    // ...yet the route's head still links the stylesheet that contains it.
    expect(html).toMatch(/<link rel="stylesheet" href="\/static\/css\/routes\/toggle\.css">/)
  })

  it('sanity check: the stylesheet file this test depends on actually exists', async () => {
    await expect(stat(join(outDir, 'static/css/routes/toggle.css'))).resolves.toBeDefined()
  })
})
