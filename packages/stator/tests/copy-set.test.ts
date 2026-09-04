import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

beforeAll(async () => {
  set = await resolveCopySet({ root })
}, 30_000)

describe('copy set: what the graph reaches', () => {
  it('copies the directories reached from routes, machines and templates', () => {
    // `templates` and `lib` are consequences of imports, not known names.
    expect(set.dirs).toContain('templates')
    expect(set.dirs).toContain('lib')
    expect(set.dirs).toContain('routes')
    expect(set.dirs).toContain('machines')
  })

  it('always copies static/, which the framework serves by path', () => {
    // static/ holds files nothing imports — the framework reads them by URL —
    // so it can never be discovered by a module graph and is never subject to
    // it. Present in the source root means present in dist, always.
    expect(set.dirs).toContain('static')
    expect(set.reached).not.toContain('static/site.css') // not via imports
  })

  it('follows a tsconfig paths alias', () => {
    // The naive "starts with a dot" test — what a regex scanner does — would
    // treat `@app/helper.ts` as a package and miss this directory entirely.
    expect(set.dirs).toContain('aliased')
    expect(set.reached).toContain('aliased/helper.ts')
  })

  it('follows an extensionless specifier', () => {
    expect(set.reached).toContain('lib/step.ts')
  })

  it('follows imports declared in .stator frontmatter', () => {
    // data/seed.json is reachable ONLY through the template's frontmatter
    // import of lib/loader.ts.
    expect(set.reached).toContain('templates/panel.stator')
    expect(set.dirs).toContain('data')
  })

  it('ignores comments and string literals that merely talk about imports', () => {
    // Found by dogfooding: a comment explaining why the app avoids
    // `import(name)` was read as a real untraceable import and failed the
    // build, and a comment mentioning a `new URL(...)` path invented a
    // directory that does not exist. Both scans read the syntax tree now, and
    // comments and string contents are not part of it.
    expect(set.untraced).toEqual([])
    expect(set.dirs).not.toContain('ghost-directory')
    expect(set.unused).not.toContain('ghost-directory')
  })

  it('follows both traceable dynamic-import forms', () => {
    expect(set.reached).toContain('lib/late.ts') // string literal
    expect(set.reached).toContain('lib/locales/en.ts') // template literal, glob-expanded
    expect(set.untraced).toEqual([])
  })

  it('copies a root-level file a module opens by URL', () => {
    expect(set.files).toContain('app.data')
  })

  it('leaves out a directory nothing reaches, and says so', () => {
    expect(set.dirs).not.toContain('unreferenced')
    expect(set.unused).toContain('unreferenced')
  })

  it('records bare specifiers as packages without tracing them', () => {
    expect(set.packages).not.toContain('node:fs') // builtins aren't packages
    expect(set.reached.some((f) => f.includes('node_modules'))).toBe(false)
  })

  it('reports app files reached outside the root rather than copying them', () => {
    // The fixture imports the framework by relative path (../../../../src),
    // which dist cannot contain — a warning, not a failure.
    expect(set.external.some((f) => f.endsWith('src/server/index.ts'))).toBe(true)
  })
})

describe('copy set: path handling across platforms', () => {
  it('contains files under a symlinked root', async () => {
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
    expect(result.dirs).toEqual(expect.arrayContaining(['lib', 'routes', 'static', 'templates']))
    expect(result.files).toContain('app.data')
    // The failure mode being guarded: everything classified as external.
    expect(result.external.filter((f) => f.includes('/app/'))).toEqual([])
    await rm(base, { recursive: true, force: true })
  }, 30_000)
})

describe('copy set: dependencies', () => {
  it('records direct dependencies only, never their transitives', async () => {
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
    expect(result.packages).toContain('primary')
    expect(result.packages).toContain('@scope/pkg') // a subpath collapses to the package
    expect(result.packages).not.toContain('secondary') // primary's own dependency
    // A type-only import is elided before resolution, so it is not a runtime
    // dependency — which is what makes it safe to check this list against
    // `dependencies` rather than `devDependencies`.
    expect(result.packages).not.toContain('typesonly')
    await rm(base, { recursive: true, force: true })
  }, 30_000)

  it('never traces or copies an in-root node_modules', async () => {
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
    expect(result.dirs).not.toContain('node_modules')
    expect(result.packages).toContain('mypkg')
    expect(result.reached.filter((f) => f.includes('node_modules'))).toEqual([])
    expect(result.untraced).toEqual([])
    await rm(base, { recursive: true, force: true })
  }, 30_000)
})

describe('copy set: untraceable dynamic imports', () => {
  let tmp: string

  beforeAll(async () => {
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

  afterAll(async () => {
    await rm(dirname(tmp), { recursive: true, force: true })
  })

  it('locates each one with file and line', async () => {
    const result = await resolveCopySet({ root: tmp })
    expect(result.untraced).toHaveLength(1)
    expect(result.untraced[0]!.file).toBe('routes/index.ts')
    expect(result.untraced[0]!.source).toContain('import(name)')
  })

  it('fails the build by default, and says how to proceed', async () => {
    await expect(buildApp({ root: tmp, outDir: join(tmp, 'dist') })).rejects.toThrow(
      /dynamic import.*cannot be traced/s,
    )
    await expect(buildApp({ root: tmp, outDir: join(tmp, 'dist') })).rejects.toThrow(
      /build\.include|untracedImports/,
    )
  })

  it("ships anyway under untracedImports: 'warn'", async () => {
    const result = await buildApp({
      root: tmp,
      outDir: join(tmp, 'dist'),
      untracedImports: 'warn',
    })
    expect(result.copySet.untraced).toHaveLength(1)
  })
})

describe('copy set: build.include', () => {
  it('copies a directory no import reaches', async () => {
    const set2 = await resolveCopySet({ root, include: ['unreferenced'] })
    expect(set2.dirs).toContain('unreferenced')
    expect(set2.unused).not.toContain('unreferenced')
  })
})

describe('copy set: what lands in dist', () => {
  const outDir = resolve(here, 'fixtures/.tmp-copy-set-dist')

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true })
  })

  it('writes the reached tree, the root data file, and nothing else', async () => {
    const result = await buildApp({ root, outDir })
    const { readdir } = await import('node:fs/promises')
    const top = (await readdir(outDir)).sort()

    expect(top).toContain('app.data') // the old copy step never got this far
    expect(top).toContain('data')
    expect(top).toContain('aliased')
    expect(top).not.toContain('unreferenced')

    // The root data file is copied byte-for-byte, not just touched.
    expect(await readFile(join(outDir, 'app.data'), 'utf8')).toBe('root-data\n')
    expect(result.copySet.unused).toContain('unreferenced')
  }, 60_000)
})
