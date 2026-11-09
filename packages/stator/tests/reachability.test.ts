import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { ReachError, reachFrom } from '../src/build/reachability.ts'
import { routeCssMap } from '../src/build/route-css.ts'

/** Write `files` (path → contents) under a fresh directory; returns its real path. */
function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stator-reach-')))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

/** A package.json; Stator-aware unless `stator` is false. */
const pkg = (name: string, exports: Record<string, string>, stator = true) =>
  JSON.stringify({
    name,
    version: '1.0.0',
    exports,
    ...(stator ? { peerDependencies: { '@statorjs/stator': '*' } } : {}),
  })

/** An app with Stator-aware packages @acme/blocks (components, one reaching
 *  another package) and @other/kit (a module with CSS, an island, a module
 *  importing back into @acme/blocks), and `plainlib`, which does not depend on
 *  Stator. */
function app(extra: Record<string, string> = {}) {
  return tree({
    'package.json': JSON.stringify({ name: 'app', type: 'module' }),
    'routes/index.ts':
      "import Hero from '@acme/blocks/hero.stator'\n" +
      "import { local } from '../lib/local.ts'\n" +
      "// import Ghost from '@acme/blocks/ghost.stator'\n" +
      "import { gone } from '../../outside.ts'\n" +
      "import { nope } from '@acme/missing'\n" +
      "import { plain } from 'plainlib'\n" +
      'export const GET = { Hero, local, gone, nope, plain }\n',
    'lib/local.ts': 'export const local = 1\n',
    'lib/local.css': '.local { color: red; }\n',
    'node_modules/@acme/blocks/package.json': pkg('@acme/blocks', {
      './hero.stator': './src/hero.stator.ts',
      './ghost.stator': './src/ghost.stator.ts',
    }),
    'node_modules/@acme/blocks/src/hero.stator.ts':
      "import Badge from './badge.stator.ts'\nimport { util } from '@other/kit/util'\nexport default Badge\n",
    'node_modules/@acme/blocks/src/hero.stator.css': '.hero { color: blue; }\n',
    'node_modules/@acme/blocks/src/badge.stator.ts': 'export default 1\n',
    'node_modules/@acme/blocks/src/badge.stator.css': '.badge { color: green; }\n',
    'node_modules/@acme/blocks/src/ghost.stator.ts': 'export default 1\n',
    'node_modules/@acme/blocks/src/ghost.stator.css': '.ghost { color: gray; }\n',
    'node_modules/@other/kit/package.json': pkg('@other/kit', {
      './util': './util.ts',
      './stepper.stator': './stepper.stator.ts',
      './loop': './loop.ts',
    }),
    'node_modules/@other/kit/util.ts': 'export const util = 1\n',
    'node_modules/@other/kit/util.css': '.util { color: black; }\n',
    'node_modules/@other/kit/stepper.stator.ts': 'export default 1\n',
    'node_modules/@other/kit/stepper.stator.client.ts': 'export {}\n',
    'node_modules/@other/kit/loop.ts':
      "import Hero from '@acme/blocks/hero.stator'\nexport default Hero\n",
    'node_modules/plainlib/package.json': pkg('plainlib', { '.': './index.ts' }, false),
    'node_modules/plainlib/index.ts': "import './inner.ts'\nexport const plain = 1\n",
    'node_modules/plainlib/inner.ts': 'export {}\n',
    'node_modules/plainlib/index.css': '.plain { color: pink; }\n',
    ...extra,
  })
}

describe('reachability', () => {
  it('crosses one bare specifier into a package and follows its relative imports', async () => {
    const root = app()
    const { modules } = await reachFrom(join(root, 'routes/index.ts'), { appRoot: root })
    const hero = modules.get(join(root, 'node_modules/@acme/blocks/src/hero.stator.ts'))
    assert.ok(hero)
    assert.equal(hero.pkg?.name, '@acme/blocks')
    assert.ok(modules.has(join(root, 'node_modules/@acme/blocks/src/badge.stator.ts')))
    assert.ok(modules.has(join(root, 'lib/local.ts')))
  })

  it('ignores imports in comments, outside the app, and that do not resolve', async () => {
    const root = app()
    const { modules } = await reachFrom(join(root, 'routes/index.ts'), { appRoot: root })
    const files = [...modules.keys()]
    assert.ok(!files.some((f) => f.endsWith('ghost.stator.ts')), 'a commented-out import')
    assert.ok(!files.some((f) => f.endsWith('outside.ts')), 'a file outside the app root')
  })

  it('follows a Stator-aware package into another, to any depth', async () => {
    const root = app()
    const { modules } = await reachFrom(join(root, 'routes/index.ts'), { appRoot: root })
    const util = modules.get(join(root, 'node_modules/@other/kit/util.ts'))
    assert.ok(util, "@acme/blocks's import of @other/kit is followed")
    assert.equal(util.pkg?.name, '@other/kit')
  })

  it('never enters a package that does not depend on Stator', async () => {
    const root = app()
    const { modules } = await reachFrom(join(root, 'routes/index.ts'), { appRoot: root })
    assert.ok(![...modules.keys()].some((f) => f.includes('plainlib')))
  })

  it('walks a cycle between packages once', async () => {
    const root = app({
      'node_modules/@acme/blocks/src/badge.stator.ts':
        "import Loop from '@other/kit/loop'\nexport default Loop\n",
    })
    const { modules } = await reachFrom(join(root, 'routes/index.ts'), { appRoot: root })
    assert.ok(modules.has(join(root, 'node_modules/@other/kit/loop.ts')))
    assert.equal(
      [...modules.keys()].filter((f) => f.endsWith('hero.stator.ts')).length,
      1,
      'the package the cycle returns to is walked once',
    )
  })

  it("refuses a package importing another package's island, naming both", async () => {
    const root = app({
      'node_modules/@acme/blocks/src/hero.stator.ts':
        "import Stepper from '@other/kit/stepper.stator'\nexport default Stepper\n",
    })
    await assert.rejects(reachFrom(join(root, 'routes/index.ts'), { appRoot: root }), (err) => {
      assert.ok(err instanceof ReachError)
      assert.match(
        err.message,
        /@acme\/blocks imports the island "@other\/kit\/stepper\.stator" from @other\/kit/,
      )
      assert.match(err.message, /import it from the app instead/)
      return true
    })
  })

  it('stops at every bare specifier with packages: false', async () => {
    const root = app()
    const { modules } = await reachFrom(join(root, 'routes/index.ts'), {
      appRoot: root,
      packages: false,
    })
    assert.ok(![...modules.values()].some((m) => m.pkg))
  })
})

describe('route CSS over the walk', () => {
  it("takes each reached package component's sibling by path, app modules first", async () => {
    const root = app()
    const css = (await routeCssMap({ routesDir: join(root, 'routes'), baseDir: root })).get(
      join(root, 'routes/index.ts'),
    )
    assert.ok(css)
    const labels = [...css.matchAll(/\/\* (.+?) \*\//g)].map((m) => m[1])
    assert.deepStrictEqual(labels, [
      'lib/local.ts',
      '@acme/blocks/src/badge.stator',
      '@acme/blocks/src/hero.stator',
      '@other/kit/util.ts',
    ])
    assert.ok(!css.includes('.ghost'), 'not a component nothing imports')
    assert.ok(!css.includes('.plain'), 'not a package that does not depend on Stator')
  })
})
