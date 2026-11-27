import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { writeArtifactDeps } from '../src/build/artifact.ts'
import { buildApp } from '../src/build/build.ts'
import { resolveCopySet } from '../src/build/copy-set.ts'
import { loadProductionHead } from '../src/build/head.ts'
import { localImports } from '../src/build/islands.ts'
import { createApp } from '../src/server/create-app.ts'

/**
 * An app's `#` subpath imports (the `imports` field of its `package.json`)
 * resolve in the build as they do in dev: the build's walks follow them, so a
 * route keeps the CSS and islands it reaches through one, and the artifact's
 * `package.json` carries the map, rewritten for the compiled `.stator.ts`
 * names, so the built route still imports at `stator start`. One the artifact
 * could not resolve fails the build, located.
 *
 * outDir sits beside the fixture, at the same depth, so the fixture's relative
 * framework imports keep resolving from the dist tree (as in build.test.ts).
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/subpath-imports-app')
const outDir = resolve(here, 'fixtures/.tmp-subpath-imports-dist')

let tmp: string | undefined
const app = async (files: Record<string, string>): Promise<string> => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'stator-subpath-')))
  const dir = join(tmp, 'app')
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true })
    await writeFile(join(dir, rel), body)
  }
  return dir
}
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = undefined
})

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  )

describe('build: # subpath imports', () => {
  before(async () => {
    await buildApp({ root, outDir })
  })
  after(async () => {
    await rm(outDir, { recursive: true, force: true })
  })

  it("keeps the route's CSS from components reached through # imports", async () => {
    const manifest = JSON.parse(await readFile(join(outDir, 'stator-manifest.json'), 'utf8'))
    assert.equal(manifest.routeCss['routes/index.ts'], '/static/css/routes/index.css')
    const css = await readFile(join(outDir, 'static/css/routes/index.css'), 'utf8')
    assert.ok(css.includes('rebeccapurple'), 'the pattern import (#components/*) brings its CSS')
    assert.ok(
      css.includes('crimson'),
      'the conditional exact import (#ui/badge.stator) brings its CSS',
    )
  })

  it('injects the island reached through a # import', async () => {
    const manifest = JSON.parse(await readFile(join(outDir, 'stator-manifest.json'), 'utf8'))
    const url = manifest.islands['components/ticker.stator']
    assert.match(url, /^\/static\/assets\/components_ticker-[\w-]+\.js$/)
    assert.deepStrictEqual(manifest.routes['routes/index.ts'], [url])
    assert.equal(await exists(join(outDir, url.replace('/static/', 'static/'))), true)
  })

  it("carries the app's imports into the generated manifest, renamed for dist", async () => {
    const pkg = JSON.parse(await readFile(join(outDir, 'package.json'), 'utf8'))
    assert.deepStrictEqual(pkg.imports, {
      '#components/*': './components/*',
      '#ui/badge.stator.ts': {
        import: './components/badge.stator.ts',
        default: './components/badge.stator.ts',
      },
    })
    assert.equal(pkg.type, 'module')
  })

  it('the built app starts and serves the page with its CSS and island', async () => {
    const { headExtras, buildId, machines } = await loadProductionHead(outDir)
    const served = await createApp({
      machinesDir: join(outDir, 'machines'),
      routesDir: join(outDir, 'routes'),
      staticDir: join(outDir, 'static'),
      headExtras,
      buildId,
      machineHashes: machines,
    })
    const res = await served.fetch(new Request('http://localhost/'))
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(html.includes('<link rel="stylesheet" href="/static/css/routes/index.css">'))
    assert.match(
      html,
      /<script type="module" src="\/static\/assets\/components_ticker-[\w-]+\.js">/,
    )
    assert.ok(html.includes('class="card'))
    assert.ok(html.includes('badge'))
    assert.ok(html.includes('<tick-tock'))
    const css = await served.fetch(new Request('http://localhost/static/css/routes/index.css'))
    assert.equal(css.status, 200)
  })
})

describe('build: # subpath imports the artifact cannot resolve', () => {
  // Each import is used: an unused one is elided before the copy set sees it.
  const route = (imports: string, used: string) =>
    `${imports}\nexport const GET = { render: () => String([${used}]) }\n`

  it('fails the build naming the file, line and specifier no imports key matches', async () => {
    const dir = await app({
      'package.json': JSON.stringify({ type: 'module', imports: { '#lib/*': './lib/*' } }),
      'routes/index.ts': route(
        "import { a } from '#lib/a.ts'\nimport { b } from '#nope/b.ts'",
        'a, b',
      ),
      'lib/a.ts': 'export const a = 1\n',
    })
    await assert.rejects(buildApp({ root: dir, outDir: join(tmp!, 'dist') }), (err: Error) => {
      assert.match(err.message, /1 `#` subpath import would not resolve/)
      assert.match(err.message, /routes\/index\.ts:2 {2}'#nope\/b\.ts': no key of the `imports`/)
      assert.ok(!err.message.includes('#lib/a.ts'))
      return true
    })
  })

  it('fails the build when the app root has no package.json to carry the imports', async () => {
    const dir = await app({
      'routes/index.ts': route("import { a } from '#lib/a.ts'", 'a'),
      'lib/a.ts': 'export const a = 1\n',
    })
    await assert.rejects(
      buildApp({ root: dir, outDir: join(tmp!, 'dist') }),
      /routes\/index\.ts:1 {2}'#lib\/a\.ts': the app root has no package\.json/,
    )
  })

  it('ignores a # import in a copied file the graph does not reach', async () => {
    const dir = await app({
      'package.json': JSON.stringify({ type: 'module', imports: { '#lib/*': './lib/*' } }),
      'routes/index.ts': route("import { a } from '#lib/a.ts'", 'a'),
      'lib/a.ts': 'export const a = 1\n',
      'lib/a.test.ts': "import { h } from '#test/helpers.ts'\nexport { h }\n",
    })
    await buildApp({ root: dir, outDir: join(tmp!, 'dist') })
  })
})

describe('copy set: a # import mapped to a package', () => {
  it('records the package the target names, not the # specifier', async () => {
    const dir = await app({
      'package.json': JSON.stringify({ type: 'module', imports: { '#kit': '@other/kit' } }),
      'routes/index.ts': "import kit from '#kit'\nexport const GET = { kit }\n",
      'node_modules/@other/kit/package.json': JSON.stringify({
        name: '@other/kit',
        version: '1.2.3',
        exports: './index.js',
      }),
      'node_modules/@other/kit/index.js': 'export default 1\n',
    })
    const set = await resolveCopySet({ root: dir })
    assert.deepStrictEqual(set.packages, ['@other/kit'])
  })
})

describe('artifact deps: a copied manifest with # imports', () => {
  it('renames .stator targets and keys, and keeps everything else', async () => {
    const own = {
      name: 'solo',
      version: '1.0.0',
      type: 'module',
      imports: { '#card': './c/card.stator', '#c/*.stator': './c/*.stator', '#lib/*': './lib/*' },
      dependencies: { '@statorjs/stator': '^3.0.0' },
    }
    const dir = await app({
      'package.json': JSON.stringify(own),
      'package-lock.json': '{"lockfileVersion":3,"packages":{}}',
    })
    await mkdir(join(dir, 'out'))
    const deps = await writeArtifactDeps({ root: dir, outDir: join(dir, 'out'), packages: [] })
    assert.equal(deps.kind, 'copied')
    const out = JSON.parse(await readFile(join(dir, 'out/package.json'), 'utf8'))
    assert.deepStrictEqual(out, {
      ...own,
      imports: {
        '#card': './c/card.stator.ts',
        '#c/*.stator.ts': './c/*.stator.ts',
        '#lib/*': './lib/*',
      },
    })
  })

  it('copies the manifest byte for byte when no import names a .stator path', async () => {
    const text = '{ "name": "solo", "type": "module", "imports": { "#lib/*": "./lib/*" } }\n'
    const dir = await app({ 'package.json': text, 'package-lock.json': '{}' })
    await mkdir(join(dir, 'out'))
    await writeArtifactDeps({ root: dir, outDir: join(dir, 'out'), packages: [] })
    assert.equal(await readFile(join(dir, 'out/package.json'), 'utf8'), text)
  })
})

describe('dev module graph: # subpath imports', () => {
  it('localImports follows a # import into the app, and bounds by directory', async () => {
    const dir = await app({
      'package.json': JSON.stringify({ type: 'module', imports: { '#lib/*': './lib/*' } }),
      'routes/index.ts':
        "import { msg } from '#lib/msg.ts'\nimport { y } from '../../app2/y.ts'\nexport { msg, y }\n",
      'lib/msg.ts': "export const msg = 'one'\n",
    })
    await mkdir(join(tmp!, 'app2'))
    await writeFile(join(tmp!, 'app2/y.ts'), 'export const y = 1\n')
    assert.deepStrictEqual(await localImports(join(dir, 'routes/index.ts'), dir), [
      join(dir, 'lib/msg.ts'),
    ])
  })
})
