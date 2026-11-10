import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bundleIslands } from '../src/build/islands.ts'

/**
 * What an island's bundle carries for a machine module its script imports:
 * the machine's code when the script runs it, the `{ name }` when it only
 * addresses it, and a build error when the script says neither or runs
 * something a browser cannot. One definition, from `@statorjs/stator/machine`,
 * serves both sides. The fixture lives under the package so `@statorjs/stator` resolves
 * through its self-link.
 */

const here = dirname(fileURLToPath(import.meta.url))
const base = resolve(here, 'fixtures/.tmp-island-machine-use')
after(() => rmSync(base, { recursive: true, force: true }))

/** A machine whose body is recognisable in a bundle by `marker`. */
const machine = (name: string, marker: string, extra = '') =>
  `import { defineMachine } from '@statorjs/stator/machine'
${extra}
export default defineMachine({
  name: '${name}',
  lifecycle: 'session',
  events: {} as { type: 'TOGGLE' },
  context: { on: false, marker: '${marker}' },
  initial: 'idle',
  states: { idle: { on: { TOGGLE: (ctx) => { ctx.on = !ctx.on } } } },
  selectors: {},
})
`

const island = (script: string, body: string) =>
  `<x-panel><button type="button" on:click={go}>go</button></x-panel>

<script>
${script}
  export class XPanel extends StatorElement {
${body}
  }
</script>
`

const GO_NOOP = '    go() {}'

let n = 0
/** Bundle one island, `templates/x-panel.stator`, in a fresh app. */
async function bundle(
  files: Record<string, string>,
  opts: { dev?: boolean } = {},
): Promise<string> {
  const root = join(base, `app-${n++}`)
  rmSync(root, { recursive: true, force: true })
  for (const [path, text] of Object.entries({
    'package.json': JSON.stringify({ name: 'island-machine-use', type: 'module' }),
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
    ...(opts.dev ? { sourcemap: true } : {}),
  })
  return result.assets.map((a) => String(a.source)).join('\n')
}

describe('an island that runs a machine', () => {
  it('bundles a machine in lib/ it passes to use()', async () => {
    const code = await bundle({
      'lib/toggle.ts': machine('Toggle', 'toggle-body'),
      'templates/x-panel.stator': island(
        "  import Toggle from '../lib/toggle.ts'",
        "    toggle = use(Toggle)\n    go() { this.toggle.send({ type: 'TOGGLE' }) }",
      ),
    })
    assert.ok(code.includes('toggle-body'))
  })

  it('bundles a machine under machines/ too: one definition, registered and run', async () => {
    const code = await bundle({
      'machines/toggle.ts': machine('Toggle', 'toggle-body'),
      'templates/x-panel.stator': island(
        "  import Toggle from '../machines/toggle.ts'",
        `    toggle = use(Toggle)\n    go() { void dispatch(Toggle, { type: 'TOGGLE' }) }`,
      ),
    })
    assert.ok(code.includes('toggle-body'))
  })

  it('follows a const alias to use()', async () => {
    const code = await bundle({
      'lib/toggle.ts': machine('Toggle', 'toggle-body'),
      'templates/x-panel.stator': island(
        "  import Toggle from '../lib/toggle.ts'\n  const Menu = Toggle",
        `    menu = use(Menu)\n${GO_NOOP}`,
      ),
    })
    assert.ok(code.includes('toggle-body'))
  })

  it('bundles a machine factory and what it produces', async () => {
    const code = await bundle({
      'lib/toggle.ts': `import { defineMachine } from '@statorjs/stator/machine'

export const makeToggle = (name: string) =>
  defineMachine({
    name,
    lifecycle: 'session',
    events: {} as { type: 'TOGGLE' },
    context: { on: false, marker: 'factory-body' },
    initial: 'idle',
    states: { idle: { on: { TOGGLE: (ctx) => { ctx.on = !ctx.on } } } },
    selectors: {},
  })
`,
      'templates/x-panel.stator': island(
        "  import { makeToggle } from '../lib/toggle.ts'\n  const Menu = makeToggle('Menu')",
        `    menu = use(Menu)\n${GO_NOOP}`,
      ),
    })
    assert.ok(code.includes('factory-body'))
  })

  it('bundles the module for a named constant the script reads', async () => {
    const code = await bundle({
      'lib/toggle.ts': `${machine('Toggle', 'toggle-body')}\nexport const LIMIT = 4242\n`,
      'templates/x-panel.stator': island(
        "  import Toggle, { LIMIT } from '../lib/toggle.ts'",
        "    go() { if (this.children.length < LIMIT) void dispatch(Toggle, { type: 'TOGGLE' }) }",
      ),
    })
    assert.ok(code.includes('4242'))
  })

  it('stubs what a bundled machine module only lists: its reads stay names', async () => {
    const code = await bundle({
      'lib/prices.ts': machine('Prices', 'prices-body'),
      'lib/cart.ts': `${machine('Cart', 'cart-body', "import Prices from './prices.ts'\n").replace(
        "lifecycle: 'session',",
        "lifecycle: 'session',\n  reads: [Prices],",
      )}\nexport const LIMIT = 4242\n`,
      'templates/x-panel.stator': island(
        "  import Cart, { LIMIT } from '../lib/cart.ts'",
        "    go() { if (this.children.length < LIMIT) void dispatch(Cart, { type: 'TOGGLE' }) }",
      ),
    })
    assert.ok(code.includes('cart-body'), 'the module the script reads a value from')
    assert.ok(code.includes('Prices'), 'the machine it reads, by name')
    assert.ok(!code.includes('prices-body'), "and none of that machine's code")
  })
})

describe('an island that only addresses a machine', () => {
  it('gets its { name } and none of its code, in machines/ and outside it', async () => {
    for (const dir of ['machines', 'lib']) {
      const code = await bundle({
        [`${dir}/cart.ts`]: machine('CartMachine', 'cart-body'),
        'templates/x-panel.stator': island(
          `  import Cart from '../${dir}/cart.ts'`,
          "    go() { void dispatch(Cart, { type: 'TOGGLE' }) }",
        ),
      })
      assert.ok(code.includes('CartMachine'), dir)
      assert.ok(!code.includes('cart-body'), dir)
    }
  })

  it('keeps a stub when the script reads its name', async () => {
    const code = await bundle({
      'machines/cart.ts': machine('CartMachine', 'cart-body'),
      'templates/x-panel.stator': island(
        "  import Cart from '../machines/cart.ts'",
        "    go() { console.log(Cart.name); void dispatch(Cart, { type: 'TOGGLE' }) }",
      ),
    })
    assert.ok(!code.includes('cart-body'))
  })

  it('says where the stub came from in a dev bundle, and not in a production one', async () => {
    const files = {
      'machines/cart.ts': machine('CartMachine', 'cart-body'),
      'templates/x-panel.stator': island(
        "  import Cart from '../machines/cart.ts'",
        "    go() { void dispatch(Cart, { type: 'TOGGLE' }) }",
      ),
    }
    assert.ok((await bundle(files, { dev: true })).includes('__stub'))
    assert.ok(!(await bundle(files)).includes('__stub'))
  })

  it('keeps the two apart in one script: one machine run, another addressed', async () => {
    const code = await bundle({
      'lib/draft.ts': machine('Draft', 'draft-body'),
      'machines/cart.ts': machine('CartMachine', 'cart-body'),
      'templates/x-panel.stator': island(
        "  import Draft from '../lib/draft.ts'\n  import Cart from '../machines/cart.ts'",
        "    draft = use(Draft)\n    go() { void dispatch(Cart, { type: 'TOGGLE' }) }",
      ),
    })
    assert.ok(code.includes('draft-body'))
    assert.ok(code.includes('CartMachine'))
    assert.ok(!code.includes('cart-body'))
  })
})

describe('an island the build refuses', () => {
  it('uses a machine import in a way that says neither, located in the .stator', async () => {
    await assert.rejects(
      bundle({
        'machines/cart.ts': machine('CartMachine', 'cart-body'),
        'templates/x-panel.stator': island(
          "  import Cart from '../machines/cart.ts'\n  const all = [Cart]",
          `    go() { void all }`,
        ),
      }),
      /templates\/x-panel\.stator:5 uses the machine import "Cart" from "\.\.\/machines\/cart\.ts" in a way the build cannot place\. Pass it straight to use\(\)/,
    )
  })

  it('reaches a machine through a barrel file', async () => {
    await assert.rejects(
      bundle({
        'lib/toggle.ts': machine('Toggle', 'toggle-body'),
        'lib/index.ts': "export { default as Toggle } from './toggle.ts'\n",
        'templates/x-panel.stator': island(
          "  import { Toggle } from '../lib/index.ts'",
          `    toggle = use(Toggle)\n${GO_NOOP}`,
        ),
      }),
      /lib\/index\.ts:1 re-exports the machine module "\.\/toggle\.ts"/,
    )
  })

  it('runs a machine module that imports the server entry', async () => {
    await assert.rejects(
      bundle({
        'lib/orders.ts': `import { sessionStore } from '@statorjs/stator/server'\n${machine(
          'Orders',
          'orders-body',
        )}\nvoid sessionStore\n`,
        'templates/x-panel.stator': island(
          "  import Orders from '../lib/orders.ts'",
          `    orders = use(Orders)\n${GO_NOOP}`,
        ),
      }),
      /lib\/orders\.ts is bundled for the browser and imports "sessionStore" from "@statorjs\/stator\/server", which is server code/,
    )
  })

  it('defines a machine it runs from the server entry, which no longer has defineMachine', async () => {
    await assert.rejects(
      bundle({
        'lib/toggle.ts': machine('Toggle', 'toggle-body').replace(
          '@statorjs/stator/machine',
          '@statorjs/stator/server',
        ),
        'templates/x-panel.stator': island(
          "  import Toggle from '../lib/toggle.ts'",
          `    toggle = use(Toggle)\n${GO_NOOP}`,
        ),
      }),
      /lib\/toggle\.ts is bundled for the browser and imports .* from "@statorjs\/stator\/server".*defineMachine from "@statorjs\/stator\/machine"/,
    )
  })

  it('imports server code from @statorjs/stator/server in its own script', async () => {
    await assert.rejects(
      bundle({
        'templates/x-panel.stator': island(
          "  import { createApp } from '@statorjs/stator/server'",
          '    go() { void createApp }',
        ),
      }),
      /templates\/x-panel\.stator is bundled for the browser and imports "createApp"/,
    )
  })

  it('runs a server-pinned machine, naming what pins it', async () => {
    await assert.rejects(
      bundle({
        'machines/prices.ts': machine('Prices', 'prices-body'),
        'machines/cart.ts': machine(
          'CartMachine',
          'cart-body',
          "import Prices from './prices.ts'\n",
        ).replace("lifecycle: 'session',", "lifecycle: 'session',\n  reads: [Prices],"),
        'templates/x-panel.stator': island(
          "  import Cart from '../machines/cart.ts'",
          `    cart = use(Cart)\n${GO_NOOP}`,
        ),
      }),
      /"CartMachine" from machines\/cart\.ts to use\(\).*server-pinned: it reads machine "Prices" \(cross-machine reads resolve server-side only\)/,
    )
  })

  it('still dispatches to that server-pinned machine without complaint', async () => {
    const code = await bundle({
      'machines/prices.ts': machine('Prices', 'prices-body'),
      'machines/cart.ts': machine(
        'CartMachine',
        'cart-body',
        "import Prices from './prices.ts'\n",
      ).replace("lifecycle: 'session',", "lifecycle: 'session',\n  reads: [Prices],"),
      'templates/x-panel.stator': island(
        "  import Cart from '../machines/cart.ts'",
        "    go() { void dispatch(Cart, { type: 'TOGGLE' }) }",
      ),
    })
    assert.ok(!code.includes('cart-body'))
    assert.ok(!code.includes('prices-body'))
  })
})
