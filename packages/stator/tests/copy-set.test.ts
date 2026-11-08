import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/build/build.ts'
import { type CopySet, resolveCopySet } from '../src/build/copy-set.ts'

/**
 * What `stator build` copies into `dist/`, derived from the app's module graph.
 *
 * The fixture is built to exercise every discovery path at once: a tsconfig
 * `paths` alias, an extensionless specifier, a `.stator` whose FRONTMATTER is
 * the only route to a lib module, a URL-relative data file in a directory
 * nothing imports, a root-level data file (the case the old directory-only copy
 * step missed entirely), both traceable `import()` forms, and a directory
 * nothing reaches at all.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/copy-set-app')

let set: CopySet

before(
  async () => {
    set = await resolveCopySet({ root })
  },
  { timeout: 30_000 },
)

describe('copy set: what the graph reaches', () => {
  it('copies the directories reached from routes, machines and templates', () => {
    // `templates` and `lib` are consequences of imports, not known names.
    assert.ok(set.dirs.includes('templates'))
    assert.ok(set.dirs.includes('lib'))
    assert.ok(set.dirs.includes('routes'))
    assert.ok(set.dirs.includes('machines'))
  })

  it('always copies static/, which the framework serves by path', () => {
    // static/ holds files nothing imports — the framework reads them by URL —
    // so it can never be discovered by a module graph and is never subject to
    // it. Present in the source root means present in dist, always.
    assert.ok(set.dirs.includes('static'))
    assert.ok(!set.reached.includes('static/site.css')) // not via imports
  })

  it('follows a tsconfig paths alias', () => {
    // The naive "starts with a dot" test — what a regex scanner does — would
    // treat `@app/helper.ts` as a package and miss this directory entirely.
    assert.ok(set.dirs.includes('aliased'))
    assert.ok(set.reached.includes('aliased/helper.ts'))
  })

  it('follows an extensionless specifier', () => {
    assert.ok(set.reached.includes('lib/step.ts'))
  })

  it('follows imports declared in .stator frontmatter', () => {
    // data/seed.json is reachable ONLY through the template's frontmatter
    // import of lib/loader.ts.
    assert.ok(set.reached.includes('templates/panel.stator'))
    assert.ok(set.dirs.includes('data'))
  })

  it('ignores comments and string literals that merely talk about imports', () => {
    // Found by dogfooding: a comment explaining why the app avoids
    // `import(name)` was read as a real untraceable import and failed the
    // build, and a comment mentioning a `new URL(...)` path invented a
    // directory that does not exist. Both scans read the syntax tree now, and
    // comments and string contents are not part of it.
    assert.deepStrictEqual(set.untraced, [])
    assert.ok(!set.dirs.includes('ghost-directory'))
    assert.ok(!set.unused.includes('ghost-directory'))
  })

  it('follows both traceable dynamic-import forms', () => {
    assert.ok(set.reached.includes('lib/late.ts')) // string literal
    assert.ok(set.reached.includes('lib/locales/en.ts')) // template literal, glob-expanded
    assert.deepStrictEqual(set.untraced, [])
  })

  it('copies a root-level file a module opens by URL', () => {
    assert.ok(set.files.includes('app.data'))
  })

  it('leaves out a directory nothing reaches, and says so', () => {
    assert.ok(!set.dirs.includes('unreferenced'))
    assert.ok(set.unused.includes('unreferenced'))
  })

  it('records bare specifiers as packages without tracing them', () => {
    assert.ok(!set.packages.includes('node:fs')) // builtins aren't packages
    assert.equal(
      set.reached.some((f) => f.includes('node_modules')),
      false,
    )
  })

  it('reports app files reached outside the root rather than copying them', () => {
    // The fixture imports the framework by relative path (../../../../src),
    // which dist cannot contain — a warning, not a failure.
    assert.equal(
      set.external.some((f) => f.endsWith('src/server/index.ts')),
      true,
    )
  })
})

describe('copy set: path handling across platforms', () => {
  it('contains files under a symlinked root', { timeout: 30_000 }, async () => {
    // esbuild reports real paths, and on macOS /var is a symlink to
    // /private/var — so a root spelled through the symlink must still contain
    // its own files. The same test protects Windows, where paths are
    // case-insensitive and a drive letter's case need not match ours: a
    // normalized `startsWith` comparison reports in-root files as external and
    // dist ends up with nothing but static/.
    const base = await mkdtemp(join(tmpdir(), 'stator-symlinked-'))
    const app = join(base, 'app')
    const { mkdir, cp } = await import('node:fs/promises')
    await mkdir(app, { recursive: true })
    for (const dir of ['routes', 'machines', 'lib', 'templates', 'static', 'data', 'aliased']) {
      await cp(join(root, dir), join(app, dir), { recursive: true })
    }
    for (const file of ['tsconfig.json', 'app.data']) {
      await cp(join(root, file), join(app, file))
    }

    const result = await resolveCopySet({ root: app })
    for (const dir of ['lib', 'routes', 'static', 'templates'])
      assert.ok(result.dirs.includes(dir), dir)
    assert.ok(result.files.includes('app.data'))
    // The failure mode being guarded: everything classified as external.
    assert.deepStrictEqual(
      result.external.filter((f) => f.includes('/app/')),
      [],
    )
    await rm(base, { recursive: true, force: true })
  })
})

describe('copy set: dependencies', () => {
  it('records direct dependencies only, never their transitives', { timeout: 30_000 }, async () => {
    // The graph stops at the first bare specifier: a dependency is marked
    // external and never loaded, so its own imports are never resolved. That is
    // the right granularity for a generated manifest — `npm ci` resolves
    // transitives from each dependency's own package.json, and listing them in
    // the app's would pin what the app does not own. Nothing here is copied
    // either way; dist gets no node_modules.
    const base = await mkdtemp(join(tmpdir(), 'stator-transitive-'))
    const app = join(base, 'app')
    const nm = join(app, 'node_modules')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(app, 'routes'), { recursive: true })
    await mkdir(join(app, 'machines'), { recursive: true })

    const pkg = async (name: string, files: Record<string, string>, manifest = {}) => {
      await mkdir(join(nm, name), { recursive: true })
      await writeFile(
        join(nm, name, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', main: 'index.js', ...manifest }),
      )
      for (const [f, body] of Object.entries(files)) await writeFile(join(nm, name, f), body)
    }
    // `primary` imports `secondary` — the shape of @statorjs/stator importing hono.
    await pkg('primary', {
      'index.js': "import { two } from 'secondary'\nexport const one = () => two()\n",
    })
    await pkg('secondary', { 'index.js': 'export const two = () => 2\n' })
    await pkg(
      '@scope/pkg',
      { 'sub.js': 'export const four = () => 4\n' },
      { exports: { './sub': './sub.js' } },
    )
    await pkg('typesonly', {
      'index.js': 'export const x = 1\n',
      'index.d.ts': 'export declare const x: number\n',
    })

    await writeFile(
      join(app, 'routes/index.ts'),
      `import { defineRoute } from '${resolve(here, '../src/server/index.ts')}'\n` +
        `import { html } from '${resolve(here, '../src/template/index.ts')}'\n` +
        `import { one } from 'primary'\n` +
        `import { four } from '@scope/pkg/sub'\n` +
        `import type { x } from 'typesonly'\n` +
        `const t: typeof x = 1\n` +
        `export const GET = defineRoute({ reads: [], render: () => html\`<p>${'${one() + four() + t}'}</p>\` })\n`,
    )

    const result = await resolveCopySet({ root: app })
    assert.ok(result.packages.includes('primary'))
    assert.ok(result.packages.includes('@scope/pkg')) // a subpath collapses to the package
    assert.ok(!result.packages.includes('secondary')) // primary's own dependency
    // A type-only import is elided before resolution, so it is not a runtime
    // dependency — which is what makes it safe to check this list against
    // `dependencies` rather than `devDependencies`.
    assert.ok(!result.packages.includes('typesonly'))
    await rm(base, { recursive: true, force: true })
  })

  it('never traces or copies an in-root node_modules', { timeout: 30_000 }, async () => {
    // The bug this guards, found by running against an app outside this
    // monorepo: a real app's `node_modules` lives INSIDE its root, so root
    // containment alone classifies every dependency as app source. The whole
    // dependency tree landed in the copy set, and the framework's own
    // `import(pathToFileURL(file).href)` in route discovery was reported as an
    // untraceable dynamic import — which would have failed the build for every
    // app that installs the framework the ordinary way.
    const base = await mkdtemp(join(tmpdir(), 'stator-deps-'))
    const app = join(base, 'app')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(app, 'routes'), { recursive: true })
    await mkdir(join(app, 'machines'), { recursive: true })
    await mkdir(join(app, 'node_modules/mypkg'), { recursive: true })
    await writeFile(
      join(app, 'node_modules/mypkg/package.json'),
      JSON.stringify({ name: 'mypkg', version: '1.0.0', main: 'index.js' }),
    )
    // A dependency with its own opaque dynamic import — exactly the framework's
    // shape. It must not be scanned, let alone reported.
    await writeFile(
      join(app, 'node_modules/mypkg/index.js'),
      'export const load = (p) => import(p)\nexport const value = 1\n',
    )
    const server = resolve(here, '../src/server/index.ts')
    const template = resolve(here, '../src/template/index.ts')
    await writeFile(
      join(app, 'routes/index.ts'),
      `import { defineRoute } from '${server}'\n` +
        `import { html } from '${template}'\n` +
        `import { value } from 'mypkg'\n` +
        `export const GET = defineRoute({ reads: [], render: () => html\`<p>${'${value}'}</p>\` })\n`,
    )

    const result = await resolveCopySet({ root: app })
    assert.ok(!result.dirs.includes('node_modules'))
    assert.ok(result.packages.includes('mypkg'))
    assert.deepStrictEqual(
      result.reached.filter((f) => f.includes('node_modules')),
      [],
    )
    assert.deepStrictEqual(result.untraced, [])
    await rm(base, { recursive: true, force: true })
  })
})

describe('copy set: untraceable dynamic imports', () => {
  let tmp: string

  before(async () => {
    const base = await mkdtemp(join(tmpdir(), 'stator-copyset-'))
    const app = join(base, 'app')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(app, 'routes'), { recursive: true })
    await mkdir(join(app, 'machines'), { recursive: true })
    // Absolute framework specifiers: a temp app sits at a different depth, so
    // the fixture's relative `../../../../src` imports would not resolve — and
    // buildApp hashes machine closures, which would fail for the wrong reason.
    const server = resolve(here, '../src/server/index.ts')
    const template = resolve(here, '../src/template/index.ts')
    const engine = resolve(here, '../src/engine/index.ts')
    await writeFile(
      join(app, 'machines/counter.ts'),
      `import { defineMachine } from '${engine}'\n` +
        `export default defineMachine({ name: 'CounterMachine', lifecycle: 'session', events: {} as { type: 'X' }, context: {}, initial: 'idle', states: { idle: {} } })\n`,
    )
    await writeFile(
      join(app, 'routes/index.ts'),
      `import { defineRoute } from '${server}'\n` +
        `import { html } from '${template}'\n` +
        `export const load = (name: string) => import(name)\n` +
        `export const GET = defineRoute({ reads: [], render: () => html\`<p>hi</p>\` })\n`,
    )
    tmp = app
  })

  after(async () => {
    await rm(dirname(tmp), { recursive: true, force: true })
  })

  it('locates each one with file and line', async () => {
    const result = await resolveCopySet({ root: tmp })
    assert.equal(result.untraced.length, 1)
    assert.equal(result.untraced[0]!.file, 'routes/index.ts')
    assert.ok(result.untraced[0]!.source.includes('import(name)'))
  })

  it('fails the build by default, and says how to proceed', async () => {
    await assert.rejects(
      buildApp({ root: tmp, outDir: join(tmp, 'dist') }),
      /dynamic import.*cannot be traced/s,
    )
    await assert.rejects(
      buildApp({ root: tmp, outDir: join(tmp, 'dist') }),
      /build\.include|untracedImports/,
    )
  })

  it("ships anyway under untracedImports: 'warn'", async () => {
    const result = await buildApp({
      root: tmp,
      outDir: join(tmp, 'dist'),
      untracedImports: 'warn',
    })
    assert.equal(result.copySet.untraced.length, 1)
  })
})

describe('copy set: build.include', () => {
  it('copies a directory no import reaches', async () => {
    const set2 = await resolveCopySet({ root, include: ['unreferenced'] })
    assert.ok(set2.dirs.includes('unreferenced'))
    assert.ok(!set2.unused.includes('unreferenced'))
  })
})

describe('copy set: what lands in dist', () => {
  const outDir = resolve(here, 'fixtures/.tmp-copy-set-dist')

  after(async () => {
    await rm(outDir, { recursive: true, force: true })
  })

  it('writes the reached tree, the root data file, and nothing else', {
    timeout: 60_000,
  }, async () => {
    const result = await buildApp({ root, outDir })
    const { readdir } = await import('node:fs/promises')
    const top = (await readdir(outDir)).sort()

    assert.ok(top.includes('app.data')) // the old copy step never got this far
    assert.ok(top.includes('data'))
    assert.ok(top.includes('aliased'))
    assert.ok(!top.includes('unreferenced'))

    // The root data file is copied byte-for-byte, not just touched.
    assert.equal(await readFile(join(outDir, 'app.data'), 'utf8'), 'root-data\n')
    assert.ok(result.copySet.unused.includes('unreferenced'))
  })
})
