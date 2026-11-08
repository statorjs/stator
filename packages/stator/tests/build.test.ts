import assert from 'node:assert/strict'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type BuildResult, buildApp } from '../src/build/build.ts'
import { loadProductionHead } from '../src/build/head.ts'
import { createApp } from '../src/server/create-app.ts'

/**
 * The production build: a `.stator` app → a `dist/` of plain `.ts`, one scoped-
 * CSS artifact PER ROUTE under `dist/static/css/` (only the components that
 * route's own import graph reaches — not a global stylesheet shared by every
 * page), and (when the app has client components) a Vite-bundled
 * `static/assets/` plus `stator-manifest.json`. The serve test runs
 * `createApp` over the dist with `loadProductionHead` — the real production
 * wiring, no Vite at serve time.
 *
 * outDir lives under `fixtures/` so the dist tree sits at the same depth as
 * the fixture source — the fixture's relative framework imports
 * (`../../../../src/...`) must keep resolving when dist files are imported.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/build-app')
const outDir = resolve(here, 'fixtures/.tmp-build-app-dist')

let result: BuildResult

before(
  async () => {
    result = await buildApp({ root, outDir })
  },
  { timeout: 60_000 },
)

after(async () => {
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
    assert.equal(result.compiled, 2)
    assert.equal(result.hasCss, true)

    // The .stator was compiled to a sibling .ts and the original removed.
    assert.equal(await exists(join(outDir, 'templates/widget.stator.ts')), true)
    assert.equal(await exists(join(outDir, 'templates/widget.stator')), false)

    // The compiled module is a real server module.
    const mod = await readFile(join(outDir, 'templates/widget.stator.ts'), 'utf8')
    assert.ok(mod.includes('export default function'))
    assert.ok(mod.includes('html`'))

    // The route's `.stator` import specifier was rewritten to `.stator.ts`.
    const route = await readFile(join(outDir, 'routes/index.ts'), 'utf8')
    assert.ok(route.includes("'../templates/widget.stator.ts'"))
    assert.ok(!route.includes("'../templates/widget.stator'"))

    const sibling = await readFile(join(outDir, 'templates/widget.stator.css'), 'utf8')
    assert.match(sibling, /\.widget\[data-s-[0-9a-f]{8}\]/)
    assert.ok(sibling.includes('teal'))

    const routeCss = await readFile(join(outDir, 'static/css/routes/index.css'), 'utf8')
    assert.ok(routeCss.includes(sibling))
  })

  it('a route that reaches no styled component gets no CSS artifact at all', async () => {
    assert.equal(await exists(join(outDir, 'static/css/routes/stepper.css')), false)
  })

  it('bundles client components to hashed assets with a manifest', async () => {
    assert.equal(result.islands, 1)

    // The client entry was written as a sibling in the dist tree.
    assert.equal(await exists(join(outDir, 'templates/stepper.stator.client.ts')), true)

    const manifest = JSON.parse(await readFile(join(outDir, 'stator-manifest.json'), 'utf8')) as {
      buildId: string
      islands: Record<string, string>
      routes: Record<string, string[]>
    }
    // The manifest carries a build-id for the reload handshake.
    assert.match(manifest.buildId, /[0-9a-f-]{36}/)
    const url = manifest.islands['templates/stepper.stator']
    assert.match(url ?? '', /^\/static\/assets\/templates_stepper-[\w-]+\.js$/)

    // Route reachability: only the stepper route reaches the island.
    assert.deepStrictEqual(manifest.routes['routes/stepper.ts'], [url])
    assert.equal(manifest.routes['routes/index.ts'], undefined)

    // The hashed asset exists on disk under the served static dir — and ships
    // UNMAPPED (inline sourcemaps are a dev-only seam option).
    const assetPath = join(outDir, url!.replace('/static/', 'static/'))
    assert.equal(await exists(assetPath), true)
    assert.ok(!(await readFile(assetPath, 'utf8')).includes('sourceMappingURL'))
  })

  it('stubs server-machine imports in the browser bundle', async () => {
    const manifest = JSON.parse(await readFile(join(outDir, 'stator-manifest.json'), 'utf8')) as {
      islands: Record<string, string>
    }
    const url = manifest.islands['templates/stepper.stator']!
    const bundle = await readFile(join(outDir, url.replace('/static/', 'static/')), 'utf8')

    // The identity survives (dispatch posts machine.name over the wire)...
    assert.ok(bundle.includes('CounterMachine'))
    assert.ok(bundle.includes('count-stepper'))
    // ...but the machine module's body never reaches the browser.
    assert.ok(!bundle.includes('server-only-machine-body'))
  })

  it('hashes every machine into the manifest (the snapshot hydration policy)', async () => {
    assert.equal(result.machines, 1)
    assert.ok(result.machineHashMs >= 0)
    // First build in this outDir: nothing to diff against.
    assert.equal(result.resetMachines, undefined)
    const manifest = JSON.parse(await readFile(join(outDir, 'stator-manifest.json'), 'utf8')) as {
      machines: Record<string, string>
    }
    assert.match(manifest.machines['counter.ts'] ?? '', /^[0-9a-f]{64}$/)
    const { machines } = await loadProductionHead(outDir)
    assert.deepStrictEqual(machines, manifest.machines)
  })

  it('refuses to boot a machine the manifest has no hash for', async () => {
    const { headExtras, buildId } = await loadProductionHead(outDir)
    await assert.rejects(
      createApp({
        machinesDir: join(outDir, 'machines'),
        routesDir: join(outDir, 'routes'),
        headExtras,
        buildId,
        machineHashes: {},
      }),
      /no code hash for machine "CounterMachine" \(counter\.ts\)/,
    )
  })

  it('serves the built dist with island script injection (no Vite)', async () => {
    const { headExtras, buildId, machines } = await loadProductionHead(outDir)
    const app = await createApp({
      machinesDir: join(outDir, 'machines'),
      routesDir: join(outDir, 'routes'),
      staticDir: join(outDir, 'static'),
      headExtras,
      buildId,
      machineHashes: machines,
    })

    // The island route gets its module script + the shell renders.
    const stepperRes = await app.fetch(new Request('http://localhost/stepper'))
    assert.equal(stepperRes.status, 200)
    const stepperHtml = await stepperRes.text()
    assert.match(
      stepperHtml,
      /<script type="module" src="\/static\/assets\/templates_stepper-[\w-]+\.js"><\/script>/,
    )
    assert.ok(stepperHtml.includes('<count-stepper'))
    assert.ok(!stepperHtml.includes('stylesheet'))

    // This fixture's render has no <head> to inject into, so check
    // headExtras directly rather than the served HTML.
    const indexRes = await app.fetch(new Request('http://localhost/'))
    const indexHtml = await indexRes.text()
    assert.ok(!indexHtml.includes('type="module"'))
    assert.ok(
      headExtras(join(outDir, 'routes/index.ts')).includes(
        '<link rel="stylesheet" href="/static/css/routes/index.css">',
      ),
    )

    // The hashed asset is served by the static handler.
    const url = stepperHtml.match(/src="(\/static\/assets\/[^"]+)"/)![1]!
    const assetRes = await app.fetch(new Request(`http://localhost${url}`))
    assert.equal(assetRes.status, 200)
    assert.ok((await assetRes.text()).includes('customElements'))
  })

  it('a rebuild reports which machines changed since the previous manifest', async () => {
    // Unchanged code ⇒ same hash ⇒ no resets.
    const same = await buildApp({ root, outDir })
    assert.deepStrictEqual(same.resetMachines, [])

    // A behaviour change in the machine ⇒ its sessions reset on deploy.
    const file = resolve(root, 'machines/counter.ts')
    const original = await readFile(file, 'utf8')
    try {
      // A comment is not code: same hash, no reset. (An added EXPORT on the
      // machine file itself would count — entry-point exports are its public
      // surface and esbuild keeps them; only imported modules are tree-shaken.)
      await writeFile(file, `${original}\n// touched\n`)
      assert.deepStrictEqual((await buildApp({ root, outDir })).resetMachines, [])
      await writeFile(file, original.replace('count: 0', 'count: 1'))
      assert.deepStrictEqual((await buildApp({ root, outDir })).resetMachines, ['counter.ts'])
    } finally {
      await writeFile(file, original)
      await buildApp({ root, outDir })
    }
  })

  it('names the manifest it compared against, and diffs against a given one instead of dist', {
    timeout: 60_000,
  }, async () => {
    // Against dist's own manifest: the default.
    const local = await buildApp({ root, outDir })
    assert.deepStrictEqual(local.resetMachines, [])
    assert.equal(local.previousManifest, join(outDir, 'stator-manifest.json'))

    // Against a manifest from elsewhere — the last DEPLOYED build's, in a
    // fresh checkout that has no dist. Its hash for counter.ts is stale.
    const deployed = join(root, 'deployed-manifest.json')
    const current = JSON.parse(await readFile(join(outDir, 'stator-manifest.json'), 'utf8')) as {
      machines: Record<string, string>
    }
    await writeFile(
      deployed,
      JSON.stringify({ ...current, machines: { ...current.machines, 'counter.ts': 'stale' } }),
    )
    try {
      const against = await buildApp({ root, outDir, previousManifest: deployed })
      assert.deepStrictEqual(against.resetMachines, ['counter.ts'])
      assert.equal(against.previousManifest, deployed)
      // Given explicitly and missing: an error, never a silent "nothing to compare".
      await assert.rejects(
        buildApp({ root, outDir, previousManifest: join(root, 'nope.json') }),
        /cannot read the previous manifest .*nope\.json/,
      )
    } finally {
      await rm(deployed, { force: true })
      await buildApp({ root, outDir })
    }
  })
})
