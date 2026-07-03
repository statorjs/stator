import { readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BuildResult, buildApp } from '../src/build/build.ts'
import { loadProductionHead } from '../src/build/head.ts'
import { createApp } from '../src/server/create-app.ts'

/**
 * The production build: a `.stator` app → a `dist/` of plain `.ts`, a
 * concatenated `components.css`, and (when the app has client components) a
 * Vite-bundled `static/assets/` plus `stator-manifest.json`. The serve test
 * runs `createApp` over the dist with `loadProductionHead` — the real
 * production wiring, no Vite at serve time.
 *
 * outDir lives under `fixtures/` so the dist tree sits at the same depth as
 * the fixture source — the fixture's relative framework imports
 * (`../../../../src/...`) must keep resolving when dist files are imported.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/build-app')
const outDir = resolve(here, 'fixtures/.tmp-build-app-dist')

let result: BuildResult

beforeAll(async () => {
  result = await buildApp({ root, outDir })
}, 60_000)

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true })
})

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('build: buildApp', () => {
  it('compiles .stator to sibling .ts, rewrites specifiers, and collects CSS', async () => {
    expect(result.compiled).toBe(2)
    expect(result.hasCss).toBe(true)

    // The .stator was compiled to a sibling .ts and the original removed.
    expect(await exists(join(outDir, 'templates/widget.stator.ts'))).toBe(true)
    expect(await exists(join(outDir, 'templates/widget.stator'))).toBe(false)

    // The compiled module is a real server module.
    const mod = await readFile(join(outDir, 'templates/widget.stator.ts'), 'utf8')
    expect(mod).toContain('export default function')
    expect(mod).toContain('html`')

    // The route's `.stator` import specifier was rewritten to `.stator.ts`.
    const route = await readFile(join(outDir, 'routes/index.ts'), 'utf8')
    expect(route).toContain("'../templates/widget.stator.ts'")
    expect(route).not.toContain("'../templates/widget.stator'")

    // Scoped CSS was concatenated to components.css.
    const css = await readFile(join(outDir, 'static/components.css'), 'utf8')
    expect(css).toMatch(/\.widget\[data-s-[0-9a-f]{8}\]/)
    expect(css).toContain('teal')
  })

  it('bundles client components to hashed assets with a manifest', async () => {
    expect(result.islands).toBe(1)

    // The client entry was written as a sibling in the dist tree.
    expect(await exists(join(outDir, 'templates/stepper.stator.client.ts'))).toBe(true)

    const manifest = JSON.parse(await readFile(join(outDir, 'stator-manifest.json'), 'utf8')) as {
      islands: Record<string, string>
      routes: Record<string, string[]>
    }
    const url = manifest.islands['templates/stepper.stator']
    expect(url).toMatch(/^\/static\/assets\/templates_stepper-[\w-]+\.js$/)

    // Route reachability: only the stepper route reaches the island.
    expect(manifest.routes['routes/stepper.ts']).toEqual([url])
    expect(manifest.routes['routes/index.ts']).toBeUndefined()

    // The hashed asset exists on disk under the served static dir.
    const assetPath = join(outDir, url!.replace('/static/', 'static/'))
    expect(await exists(assetPath)).toBe(true)
  })

  it('stubs server-machine imports in the browser bundle', async () => {
    const manifest = JSON.parse(await readFile(join(outDir, 'stator-manifest.json'), 'utf8')) as {
      islands: Record<string, string>
    }
    const url = manifest.islands['templates/stepper.stator']!
    const bundle = await readFile(join(outDir, url.replace('/static/', 'static/')), 'utf8')

    // The identity survives (dispatch posts machine.name over the wire)...
    expect(bundle).toContain('CounterMachine')
    expect(bundle).toContain('count-stepper')
    // ...but the machine module's body never reaches the browser.
    expect(bundle).not.toContain('server-only-machine-body')
  })

  it('serves the built dist with island script injection (no Vite)', async () => {
    const app = await createApp({
      machinesDir: join(outDir, 'machines'),
      routesDir: join(outDir, 'routes'),
      staticDir: join(outDir, 'static'),
      headExtras: await loadProductionHead(outDir),
    })

    // The island route gets its module script + the shell renders.
    const stepperRes = await app.fetch(new Request('http://localhost/stepper'))
    expect(stepperRes.status).toBe(200)
    const stepperHtml = await stepperRes.text()
    expect(stepperHtml).toMatch(
      /<script type="module" src="\/static\/assets\/templates_stepper-[\w-]+\.js"><\/script>/,
    )
    expect(stepperHtml).toContain('<count-stepper')
    expect(stepperHtml).toContain('<link rel="stylesheet" href="/static/components.css">')

    // The island-free route gets CSS but no island script.
    const indexRes = await app.fetch(new Request('http://localhost/'))
    const indexHtml = await indexRes.text()
    expect(indexHtml).not.toContain('type="module"')

    // The hashed asset is served by the static handler.
    const url = stepperHtml.match(/src="(\/static\/assets\/[^"]+)"/)![1]!
    const assetRes = await app.fetch(new Request(`http://localhost${url}`))
    expect(assetRes.status).toBe(200)
    expect(await assetRes.text()).toContain('customElements')
  })
})
