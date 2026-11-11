import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bundleIslands } from '../src/build/islands.ts'

/**
 * A dispatch-only island must never ship the machine it addresses. The stub
 * decision is made on the file the bundler resolves and on what the script
 * does with the import, so no spelling of the import, and no slip in how a
 * type is imported, is a way round it. The fixture's machine imports a module
 * holding a literal secret: if the machine's code reaches the bundle, so does
 * the secret.
 */

const here = dirname(fileURLToPath(import.meta.url))
const base = resolve(here, 'fixtures/.tmp-island-machine-leaks')
after(() => rmSync(base, { recursive: true, force: true }))

const SECRET =
  "export const KEY = 'sk_live_SECRETMARKER'\nexport const charge = async () => KEY.length\n"
const machine = (dir: string) => `import { defineMachine } from '@statorjs/stator/machine'
import { charge } from '${dir}/lib/secret.ts'

export type CartEvents = { type: 'ADD' } | { type: 'PAID' }
export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  events: {} as CartEvents,
  context: { n: 0, marker: 'MACHINEBODY' },
  initial: 'idle',
  states: { idle: { on: { ADD: { do: (ctx) => { ctx.n++ }, effect: async () => { await charge(); return { type: 'PAID' } } }, PAID: () => {} } } },
  selectors: {},
})
`
const island = (script: string, body: string) =>
  `<x-panel><button type="button" on:click={go}>go</button></x-panel>\n\n<script>\n${script}\n  export class XPanel extends StatorElement {\n${body}\n  }\n</script>\n`

let n = 0
async function bundle(files: Record<string, string>): Promise<string> {
  const root = join(base, `app-${n++}`)
  for (const [path, text] of Object.entries({
    'package.json': JSON.stringify({
      name: 'probe',
      type: 'module',
      imports: { '#machines/*': './machines/*' },
    }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['./*'] } },
    }),
    'lib/secret.ts': SECRET,
    ...files,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  mkdirSync(join(root, 'machines'), { recursive: true })
  const result = await bundleIslands({
    root,
    machinesDir: join(root, 'machines'),
    entries: [{ rel: 'templates/x-panel.stator', file: join(root, 'templates/x-panel.stator') }],
  })
  return result.assets.map((a) => String(a.source)).join('\n')
}
const shipped = (js: string) => ({
  machine: js.includes('MACHINEBODY'),
  secret: js.includes('SECRETMARKER'),
})
const NOTHING = { machine: false, secret: false }
const DISPATCH = "    go() { void dispatch(Cart, { type: 'ADD' }) }"
const page = (script: string, body = DISPATCH) => ({
  'machines/cart.ts': machine('..'),
  'templates/x-panel.stator': island(script, body),
})

describe('a dispatch-only island ships no machine code, however the import is written', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['a relative default import', page("  import Cart from '../machines/cart.ts'")],
    ['an extensionless import', page("  import Cart from '../machines/cart'")],
    ['a `.js` specifier for the `.ts` file', page("  import Cart from '../machines/cart.js'")],
    ['a tsconfig `paths` alias', page("  import Cart from '@app/machines/cart.ts'")],
    ['a package `imports` alias', page("  import Cart from '#machines/cart.ts'")],
    [
      'a type imported beside it without the `type` keyword',
      page(
        "  import Cart, { CartEvents } from '../machines/cart.ts'",
        "    go() { const e: CartEvents = { type: 'ADD' }; void dispatch(Cart, e) }",
      ),
    ],
    [
      "a parameter elsewhere in the script with the import's name",
      page(
        "  import Cart from '../machines/cart.ts'\n  const total = (Cart: { items: number[] }) => Cart.items.length",
        `${DISPATCH}\n    n() { return total({ items: [] }) }`,
      ),
    ],
    [
      "a block-scoped local with the import's name",
      page(
        "  import Cart from '../machines/cart.ts'",
        `${DISPATCH}\n    n() { for (const Cart of [{ items: [1] }]) return Cart.items.length; return 0 }`,
      ),
    ],
    [
      'a machine outside machines/, by a `.js` specifier',
      {
        'shared/cart.ts': machine('..'),
        'templates/x-panel.stator': island("  import Cart from '../shared/cart.js'", DISPATCH),
      },
    ],
    [
      'a machine outside machines/, by an alias',
      {
        'shared/cart.ts': machine('..'),
        'templates/x-panel.stator': island("  import Cart from '@app/shared/cart.ts'", DISPATCH),
      },
    ],
  ]
  for (const [name, files] of cases) {
    it(name, async () => {
      const js = await bundle(files)
      assert.deepEqual(shipped(js), NOTHING)
      assert.ok(js.includes('CartMachine'), 'the stub still names the machine')
    })
  }
})

describe('the same spellings still run a machine the script passes to use()', () => {
  const RUN = '    cart = use(Cart)\n    go() {}'
  for (const spec of ['@app/machines/cart.ts', '#machines/cart.ts', '../machines/cart.js']) {
    it(spec, async () => {
      assert.equal(shipped(await bundle(page(`  import Cart from '${spec}'`, RUN))).machine, true)
    })
  }

  it('a named export read as a value brings the module', async () => {
    const js = await bundle({
      'machines/cart.ts': `${machine('..')}export const LIMIT = 3\n`,
      'templates/x-panel.stator': island(
        "  import Cart, { LIMIT } from '../machines/cart.ts'",
        "    go() { if (LIMIT > 0) void dispatch(Cart, { type: 'ADD' }) }",
      ),
    })
    assert.equal(shipped(js).machine, true)
  })

  it('an unplaceable use through an alias is still a build error', async () => {
    await assert.rejects(
      bundle(page("  import Cart from '@app/machines/cart.ts'", '    go() { console.log(Cart) }')),
      /uses the machine import "Cart" from "@app\/machines\/cart\.ts" in a way the build cannot place/,
    )
  })
})
