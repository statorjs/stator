import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { probeModule, scanImports } from '../src/build/imports.ts'
import { SERVER_STATOR } from '../src/build/lib-client.ts'
import { entryMachines, entryTags } from '../src/build/library-islands.ts'
import { isMachineModule, machineImportUse, serverImports } from '../src/build/machines.ts'

/**
 * The TypeScript-API reads the island build makes: the import scanner, the one
 * definition of a machine module, what a script does with one it imports, the
 * reads of compiled client entries,
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

describe('isMachineModule', () => {
  const definer = resolve(here, '../src/server/define-machine.ts')
  const root = tree({
    'named.ts': "import { defineMachine } from '@statorjs/stator/machine'\nexport default 1\n",
    'aliased.ts':
      "import { defineMachine as dm } from '@statorjs/stator/machine'\nexport default 1\n",
    'ns.ts':
      "import * as S from '@statorjs/stator/machine'\nexport default S.defineMachine({} as never)\n",
    'ns-unused.ts': "import * as S from '@statorjs/stator/machine'\nexport default S\n",
    'by-path.ts': `import { defineMachine } from '${definer}'\nexport default 1\n`,
    'reexport.ts': "export { defineMachine } from '@statorjs/stator/machine'\n",
    'via-local.ts': "import { defineMachine } from './reexport.ts'\nexport default 1\n",
    'via-local-ext.ts': "import { defineMachine } from './reexport'\nexport default 1\n",
    'commented.ts':
      "// import { defineMachine } from '@statorjs/stator/machine'\nexport default 1\n",
    'type-only.ts':
      "import { type defineMachine } from '@statorjs/stator/machine'\nexport default 1\n",
    'other.ts': "import { defineMachine } from 'some-other-lib'\nexport default 1\n",
    'server-entry.ts':
      "import { createApp } from '@statorjs/stator/server'\nexport default createApp\n",
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
    ['server-entry.ts', false],
  ]
  for (const [file, expected] of cases) {
    it(`${file} → ${expected}`, () => {
      assert.equal(isMachineModule(join(root, file)), expected)
    })
  }

  it("never counts Stator's own modules", () => {
    assert.equal(isMachineModule(resolve(here, '../src/client/machine.ts')), false)
  })
})

describe('machineImportUse', () => {
  const island = (script: string) =>
    `<x-y><button on:click={go}>go</button></x-y>\n\n<script>\n${script}\n</script>\n`
  const cls = (body: string) => `export class XY extends StatorElement {\n${body}\n}`

  type Case = {
    name: string
    file: string
    text: string
    expect: 'stub' | 'error' | string[]
    lenient?: boolean
    message?: RegExp
  }
  const cases: Case[] = [
    {
      name: 'the default import passed to use()',
      file: 'run.stator',
      text: island(`import Cart from './m.ts'\n${cls('  cart = use(Cart)')}`),
      expect: ['default'],
    },
    {
      name: 'the same in a compiled client entry',
      file: 'run.stator.client.ts',
      text: "import Cart from './m.ts'\nexport class XY { cart = use(Cart, { items: [] }) }\n",
      expect: ['default'],
    },
    {
      name: 'an import only dispatched to',
      file: 'dispatch.stator',
      text: island(
        `import Cart from './m.ts'\n${cls("  go() { void dispatch(Cart, { type: 'ADD' }) }")}`,
      ),
      expect: 'stub',
    },
    {
      name: 'an import run and dispatched to',
      file: 'both.stator',
      text: island(
        `import Cart from './m.ts'\n${cls("  cart = use(Cart)\n  go() { void dispatch(Cart, { type: 'ADD' }) }")}`,
      ),
      expect: ['default'],
    },
    {
      name: 'reading only the name',
      file: 'name.ts',
      text: "import Cart from './m.ts'\nconsole.log(Cart.name)\n",
      expect: 'stub',
    },
    {
      name: 'reading any other property, which needs the definition',
      file: 'selectors.ts',
      text: "import Cart from './m.ts'\nexport const total = Cart.selectors.total\n",
      expect: [],
    },
    {
      name: 'a const alias passed to use()',
      file: 'alias.ts',
      text: "import Cart from './m.ts'\nconst Local = Cart\nexport const c = use(Local)\n",
      expect: ['default'],
    },
    {
      name: 'an alias of an alias, declared after its use',
      file: 'alias2.ts',
      text: "import Cart from './m.ts'\nexport const c = () => use(B)\nconst B = A\nconst A = Cart\n",
      expect: ['default'],
    },
    {
      name: 'an alias only dispatched to',
      file: 'alias-dispatch.ts',
      text: "import Cart from './m.ts'\nconst Local = Cart\nvoid dispatch(Local, { type: 'ADD' })\n",
      expect: 'stub',
    },
    {
      name: 'an import wrapped in a cast',
      file: 'cast.ts',
      text: "import Cart from './m.ts'\nexport const c = use((Cart as never)!)\n",
      expect: ['default'],
    },
    {
      name: 'a factory called into a const, then run',
      file: 'factory.stator',
      text: island(
        `import { makeToggle } from './m.ts'\nconst Menu = makeToggle('Menu')\n${cls('  menu = use(Menu)')}`,
      ),
      expect: ['(factory)'],
    },
    {
      name: 'a factory called inside use()',
      file: 'factory-inline.ts',
      text: "import { makeToggle } from './m.ts'\nexport const m = use(makeToggle('Menu'))\n",
      expect: ['(factory)'],
    },
    {
      name: 'a default-exported factory whose product is only dispatched to',
      file: 'factory-default.ts',
      text: "import make from './m.ts'\nconst Menu = make('Menu')\nvoid dispatch(Menu, { type: 'T' })\n",
      expect: [],
    },
    {
      name: 'a named machine export under an alias, run',
      file: 'named.ts',
      text: "import { Cart as C } from './m.ts'\nexport const c = use(C)\n",
      expect: ['Cart'],
    },
    {
      name: 'a named constant, which needs the module',
      file: 'constant.ts',
      text: "import { LIMIT } from './m.ts'\nexport const over = (n: number) => n > LIMIT\n",
      expect: [],
    },
    {
      name: "a namespace import's default, run",
      file: 'namespace.ts',
      text: "import * as M from './m.ts'\nexport const c = use(M.default)\n",
      expect: ['default'],
    },
    {
      name: 'a dynamic import',
      file: 'dynamic.ts',
      text: "export const load = () => import('./m.ts')\n",
      expect: [],
    },
    {
      name: 'a type-only import',
      file: 'type-only.ts',
      text: "import type Cart from './m.ts'\nexport type C = typeof Cart\n",
      expect: 'stub',
    },
    {
      name: 'a default import beside type-only named ones, dispatched to',
      file: 'with-types.ts',
      text: "import Cart, { type Item } from './m.ts'\nexport const i: Item[] = []\nvoid dispatch(Cart, { type: 'ADD' })\n",
      expect: 'stub',
    },
    {
      name: 'use() and the import named only in a comment and a string',
      file: 'quoted.ts',
      text: "import Cart from './m.ts'\n// use(Cart)\nconst s = 'use(Cart)'\nvoid dispatch(Cart, { type: s })\n",
      expect: 'stub',
    },
    {
      name: 'a use in a type position beside a dispatch',
      file: 'typeof.ts',
      text: "import Cart from './m.ts'\ntype E = typeof Cart\nvoid dispatch(Cart, {} as E)\n",
      expect: 'stub',
    },
    {
      name: 'the import handed to some other function',
      file: 'handed.stator',
      text: island(`import Cart from './m.ts'\n${cls('  go() { register(Cart) }')}`),
      expect: 'error',
      message:
        /handed\.stator:6 uses the machine import "Cart" from "\.\/m\.ts" in a way the build cannot place/,
    },
    {
      name: 'the import in an array',
      file: 'array.ts',
      text: "import Cart from './m.ts'\nexport const all = [Cart]\n",
      expect: 'error',
      message: /array\.ts:2 uses the machine import "Cart"/,
    },
    {
      name: 'the import as a shorthand property',
      file: 'shorthand.ts',
      text: "import Cart from './m.ts'\nexport const all = { Cart }\n",
      expect: 'error',
    },
    {
      name: 'the import exported from the script',
      file: 'exported.ts',
      text: "import Cart from './m.ts'\nexport { Cart }\n",
      expect: 'error',
    },
    {
      name: 'the import as the default export',
      file: 'export-default.ts',
      text: "import Cart from './m.ts'\nexport default Cart\n",
      expect: 'error',
    },
    {
      name: 'an alias handed to some other function',
      file: 'alias-handed.ts',
      text: "import Cart from './m.ts'\nconst Local = Cart\nregister(Local)\n",
      expect: 'error',
      message: /uses the machine import "Local"/,
    },
    {
      name: 'a re-export of the machine module',
      file: 'barrel.ts',
      text: "export { default as Cart } from './m.ts'\n",
      expect: 'error',
      message: /barrel\.ts:1 re-exports the machine module "\.\/m\.ts"/,
    },
    {
      name: 'export * of the machine module',
      file: 'barrel-star.ts',
      text: "export * from './m.ts'\n",
      expect: 'error',
    },
    {
      name: 'a machine module listing another in reads',
      file: 'reads.ts',
      text: "import Prices from './m.ts'\nexport default { reads: [Prices] }\n",
      expect: 'stub',
      lenient: true,
    },
    {
      name: 'a machine module re-exporting another',
      file: 'machines-reexport.ts',
      text: "export { default } from './m.ts'\n",
      expect: [],
      lenient: true,
    },
    {
      name: 'a machine module building on a factory',
      file: 'from-factory.ts',
      text: "import { makeToggle } from './m.ts'\nexport default makeToggle('Menu')\n",
      expect: [],
      lenient: true,
    },
  ]
  const root = tree(Object.fromEntries(cases.map((c) => [c.file, c.text])))

  for (const c of cases) {
    it(`${c.name} → ${Array.isArray(c.expect) ? `real, runs [${c.expect}]` : c.expect}`, () => {
      const use = machineImportUse(join(root, c.file), './m.ts', { lenient: c.lenient, root })
      assert.ok(use, 'the script imports the module')
      if (Array.isArray(c.expect)) {
        assert.deepStrictEqual(use, { kind: 'real', runs: c.expect })
      } else {
        assert.equal(use.kind, c.expect)
      }
      if (c.message) assert.match((use as { message: string }).message, c.message)
    })
  }

  it('is undefined for a specifier the script never imports, and for a missing file', () => {
    assert.equal(machineImportUse(join(root, 'run.stator'), './other.ts'), undefined)
    assert.equal(machineImportUse(join(root, 'nope.ts'), './m.ts'), undefined)
  })

  it('reads a .stator file through its script only, never its frontmatter', () => {
    const dir = tree({
      'fenced.stator': `---\nimport Cart from './m.ts'\nconst all = [Cart]\n---\n${island(
        `import Cart from './m.ts'\n${cls('  cart = use(Cart)')}`,
      )}`,
    })
    assert.deepStrictEqual(machineImportUse(join(dir, 'fenced.stator'), './m.ts'), {
      kind: 'real',
      runs: ['default'],
    })
  })
})

describe('serverImports', () => {
  const S = '@statorjs/stator/server'
  const cases: Array<[label: string, text: string, expected: string[]]> = [
    ['a store', `import { sessionStore } from '${S}'\n`, ['sessionStore']],
    [
      'createApp beside a type',
      `import { createApp, type StatorConfig } from '${S}'\n`,
      ['createApp'],
    ],
    [
      'a type imported without the type keyword',
      `import { MachineDef } from '${S}'\nexport type M = MachineDef\n`,
      [],
    ],
    [
      'a namespace import',
      `import * as S from '${S}'\nexport const app = S.createApp({})\n`,
      ['*'],
    ],
    ['a default import', `import server from '${S}'\nvoid server\n`, ['default']],
    ['export * of the entry', `export * from '${S}'\n`, ['*']],
    ['a type-only import', `import type { StatorConfig } from '${S}'\n`, []],
    ['the machine entry', "import { defineMachine } from '@statorjs/stator/machine'\n", []],
  ]
  const root = tree(Object.fromEntries(cases.map(([, text], i) => [`case-${i}.ts`, text])))
  cases.forEach(([label, , expected], i) => {
    it(`${label} → [${expected}]`, async () => {
      assert.deepStrictEqual(await serverImports(join(root, `case-${i}.ts`)), expected)
    })
  })

  it('reads a .stator island through its script', async () => {
    const dir = tree({
      'island.stator': `<x-y></x-y>\n\n<script>\n  import { sessionStore } from '${S}'\n  export class XY extends StatorElement { s = sessionStore }\n</script>\n`,
    })
    assert.deepStrictEqual(await serverImports(join(dir, 'island.stator')), ['sessionStore'])
  })

  it('finds no defineMachine there: the machine entry is its one home', async () => {
    const server = await import('../src/server/index.ts')
    const engine = await import('../src/engine/index.ts')
    assert.equal('defineMachine' in server, false)
    assert.equal(typeof engine.defineMachine, 'function')
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
      '@statorjs/stator/machine',
      '@statorjs/stator/template',
      '@statorjs/stator/components.css',
    ]) {
      assert.ok(!SERVER_STATOR.includes(spec), spec)
    }
  })
})
