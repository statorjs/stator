import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { probeModule, scanImports } from '../src/build/imports.ts'
import { SERVER_STATOR } from '../src/build/lib-client.ts'
import { entryMachines, entryTags } from '../src/build/library-islands.ts'
import { isServerMachineModule } from '../src/build/machines.ts'

/**
 * The TypeScript-API reads the island build makes: the import scanner, the one
 * definition of a server machine module, the reads of compiled client entries,
 * and the server-side Stator subpaths derived from the package's `exports`.
 */

const here = dirname(fileURLToPath(import.meta.url))

function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stator-imports-')))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe('scanImports', () => {
  it('reads every static form, and nothing in a comment or a string', () => {
    const code = [
      "import a from './a.ts'",
      "import { b as c, type D } from './b.ts'",
      "import * as ns from './ns.ts'",
      "import './side.ts'",
      "export { e } from './e.ts'",
      "export * from './star.ts'",
      "import f = require('./f.js')",
      "const g = await import('./g.ts')",
      "// import ghost from './ghost.ts'",
      "/* import ghost2 from './ghost2.ts' */",
      'const s = "import ghost3 from \'./ghost3.ts\'"',
      "const t = `export * from './ghost4.ts'`",
    ].join('\n')
    const imports = scanImports(code, '/x/mod.ts')
    assert.deepStrictEqual(
      imports.map((i) => i.spec),
      ['./a.ts', './b.ts', './ns.ts', './side.ts', './e.ts', './star.ts', './f.js', './g.ts'],
    )
    const [a, b, ns] = imports
    assert.equal(a!.defaultName, 'a')
    assert.equal(code.slice(a!.start, a!.end), "import a from './a.ts'")
    assert.deepStrictEqual(b!.named, [
      { imported: 'b', local: 'c', typeOnly: false },
      { imported: 'D', local: 'D', typeOnly: true },
    ])
    assert.equal(ns!.namespace, 'ns')
    assert.equal(imports[5]!.exportStar, true)
  })

  it("reads a .stator file's frontmatter and script, with offsets into the file", () => {
    const code =
      "---\nimport Card from './card.stator'\n// import Ghost from './ghost.stator'\n---\n" +
      "<p>import Nope from './nope.ts'</p>\n<script>\n  import { x } from './x.ts'\n</script>\n"
    const imports = scanImports(code, '/x/page.stator')
    assert.deepStrictEqual(
      imports.map((i) => i.spec),
      ['./card.stator', './x.ts'],
    )
    for (const imp of imports) assert.match(code.slice(imp.start, imp.end), /^import /)
  })
})

describe('probeModule', () => {
  it('probes .ts, .js, /index.ts and /index.js for an extensionless specifier', () => {
    const root = tree({ 'a.ts': '', 'b.js': '', 'c/index.ts': '', 'd/index.js': '', 'e.ts': '' })
    assert.equal(probeModule(join(root, 'a')), join(root, 'a.ts'))
    assert.equal(probeModule(join(root, 'b')), join(root, 'b.js'))
    assert.equal(probeModule(join(root, 'c')), join(root, 'c/index.ts'))
    assert.equal(probeModule(join(root, 'd')), join(root, 'd/index.js'))
    assert.equal(probeModule(join(root, 'e.ts')), join(root, 'e.ts'))
    assert.equal(probeModule(join(root, 'missing')), undefined)
  })
})

describe('isServerMachineModule', () => {
  const definer = resolve(here, '../src/server/define-machine.ts')
  const root = tree({
    'named.ts': "import { defineMachine } from '@statorjs/stator/server'\nexport default 1\n",
    'aliased.ts':
      "import { defineMachine as dm } from '@statorjs/stator/machine'\nexport default 1\n",
    'ns.ts':
      "import * as S from '@statorjs/stator/server'\nexport default S.defineMachine({} as never)\n",
    'ns-unused.ts': "import * as S from '@statorjs/stator/server'\nexport default S\n",
    'by-path.ts': `import { defineMachine } from '${definer}'\nexport default 1\n`,
    'reexport.ts': "export { defineMachine } from '@statorjs/stator/server'\n",
    'via-local.ts': "import { defineMachine } from './reexport.ts'\nexport default 1\n",
    'via-local-ext.ts': "import { defineMachine } from './reexport'\nexport default 1\n",
    'commented.ts':
      "// import { defineMachine } from '@statorjs/stator/server'\nexport default 1\n",
    'type-only.ts':
      "import { type defineMachine } from '@statorjs/stator/server'\nexport default 1\n",
    'other.ts': "import { defineMachine } from 'some-other-lib'\nexport default 1\n",
  })
  const cases: Array<[string, boolean]> = [
    ['named.ts', true],
    ['aliased.ts', true],
    ['ns.ts', true],
    ['ns-unused.ts', false],
    ['by-path.ts', true],
    ['via-local.ts', true],
    ['via-local-ext.ts', true],
    ['reexport.ts', false],
    ['commented.ts', false],
    ['type-only.ts', false],
    ['other.ts', false],
  ]
  for (const [file, expected] of cases) {
    it(`${file} → ${expected}`, () => {
      assert.equal(isServerMachineModule(join(root, file)), expected)
    })
  }

  it("never counts Stator's own modules", () => {
    assert.equal(isServerMachineModule(resolve(here, '../src/client/machine.ts')), false)
  })
})

describe('reading a compiled client entry', () => {
  const entry = [
    "import { defineElement } from '@statorjs/stator/client'",
    'const Counter = /* @stator machine */ { name: "CounterMachine" };',
    '// defineElement(Fake, "fake-tag") and /* @stator machine */ { name: "Ghost" }',
    'const s = \'defineElement(X, "string-tag")\'',
    'const plain = { name: "NotAStub" }',
    'defineElement(__CountStepperImpl, "count-stepper")',
  ].join('\n')

  it('finds each defineElement tag, and none in a comment or a string', () => {
    assert.deepStrictEqual(entryTags(entry), ['count-stepper'])
  })

  it('finds each machine stub, and none in a comment or an unmarked object', () => {
    assert.deepStrictEqual(entryMachines(entry), ['CounterMachine'])
  })
})

describe('SERVER_STATOR', () => {
  it("is every code subpath of @statorjs/stator's exports but the browser-safe ones", () => {
    for (const spec of [
      '@statorjs/stator',
      '@statorjs/stator/server',
      '@statorjs/stator/server/runtime',
      '@statorjs/stator/machine',
      '@statorjs/stator/dev',
      '@statorjs/stator/build',
      '@statorjs/stator/register',
      '@statorjs/stator/test-env',
      '@statorjs/stator/config',
      '@statorjs/stator/compiler',
      '@statorjs/stator/components',
    ]) {
      assert.ok(SERVER_STATOR.includes(spec), spec)
    }
    for (const spec of [
      '@statorjs/stator/client',
      '@statorjs/stator/template',
      '@statorjs/stator/components.css',
    ]) {
      assert.ok(!SERVER_STATOR.includes(spec), spec)
    }
  })
})
