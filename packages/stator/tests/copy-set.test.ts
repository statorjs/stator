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
    expect(set.dirs).toContain('static')
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
