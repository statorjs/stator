import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { routeCssMap } from '../src/build/route-css.ts'

/**
 * `routeCssMap`'s `node_modules` path: a route that imports a bare specifier
 * gets that package's sibling `${specifier}.css` export folded into its own
 * route artifact, resolved through the package's `exports` map — the same
 * one-hop lookup a published `.stator` component library relies on, with no
 * real library needed to exercise it (spec
 * `stator-component-libraries-publish-time-compile-per-component-scoped-css-usage-driven-aggregation`).
 *
 * The `node_modules` fixture is built in a temp dir at test time, not checked
 * into `tests/fixtures/` — `node_modules/` is gitignored repo-wide, so a
 * static fixture under it would silently vanish from a fresh clone/CI (same
 * reason `copy-set.test.ts`'s `node_modules` fixtures are built this way).
 */

let base: string | undefined

afterEach(async () => {
  if (base) await rm(base, { recursive: true, force: true })
  base = undefined
})

async function buildFixture(): Promise<string> {
  base = await mkdtemp(join(tmpdir(), 'stator-route-css-'))
  const root = join(base, 'app')
  await mkdir(join(root, 'routes'), { recursive: true })
  const lib = join(root, 'node_modules/fake-lib')
  await mkdir(lib, { recursive: true })
  await writeFile(
    join(lib, 'package.json'),
    JSON.stringify({
      name: 'fake-lib',
      exports: {
        './button': './button.js',
        './button.css': './button.css',
        './plain': './plain.js',
      },
    }),
  )
  await writeFile(join(lib, 'button.js'), 'export default {}\n')
  await writeFile(join(lib, 'button.css'), '.button[data-s-fake1234] { color: red; }\n')
  await writeFile(
    join(root, 'routes/x.ts'),
    "import Button from 'fake-lib/button'\n" +
      "import Plain from 'fake-lib/plain'\n" +
      'export const x = { Button, Plain }\n',
  )
  await writeFile(join(root, 'routes/y.ts'), 'export const y = 1\n')
  return root
}

describe('route-css: routeCssMap', () => {
  it('resolves a node_modules package sibling .css export for a reached bare specifier', async () => {
    const root = await buildFixture()
    const map = await routeCssMap({ routesDir: join(root, 'routes'), baseDir: root })
    const css = map.get(join(root, 'routes/x.ts'))
    expect(css).toBeDefined()
    expect(css).toContain('.button[data-s-fake1234] { color: red; }')
  })

  it('silently skips a bare specifier whose package declares no sibling .css', async () => {
    const root = await buildFixture()
    const map = await routeCssMap({ routesDir: join(root, 'routes'), baseDir: root })
    const css = map.get(join(root, 'routes/x.ts'))!
    // fake-lib/plain has no `./plain.css` export — reached, but contributes
    // nothing, and does not throw.
    expect(css).not.toContain('plain')
  })

  it('a route reaching no styled component at all has no entry', async () => {
    const root = await buildFixture()
    const map = await routeCssMap({ routesDir: join(root, 'routes'), baseDir: root })
    expect(map.has(join(root, 'routes/y.ts'))).toBe(false)
  })

  it('does not mistake a doc-comment usage example for a real import', async () => {
    // Regression: json-ld.ts's own doc comment has a completely normal
    // `*   import { JsonLd } from '@statorjs/stator/components'` usage
    // example. Before the scanner stripped comments, this made a route
    // "reach" fake-lib/button purely because a comment mentioned it —
    // worse, when the resolved target was the very file being written
    // (a package's own barrel aggregating its own CSS), each build run
    // re-read the previous run's stale output as newly "reached" and
    // appended it again, growing the file without bound.
    const root = await buildFixture()
    await writeFile(
      join(root, 'routes/z.ts'),
      '/**\n' +
        ' * Usage:\n' +
        " *   import Button from 'fake-lib/button'\n" +
        ' */\n' +
        "// import Button from 'fake-lib/button'\n" +
        'export const z = 1\n',
    )
    const map = await routeCssMap({ routesDir: join(root, 'routes'), baseDir: root })
    expect(map.has(join(root, 'routes/z.ts'))).toBe(false)
  })
})
