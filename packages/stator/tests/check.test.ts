import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { after, afterEach, describe, it, mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkStack } from '../src/cli/commands/check.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '.tmp-check-app')

const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    skipLibCheck: true,
    types: [],
  },
  include: ['lib'],
})

async function scaffold(route: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, 'lib'), { recursive: true })
  await mkdir(join(root, 'routes'), { recursive: true })
  await writeFile(join(root, 'tsconfig.json'), tsconfig)
  await writeFile(join(root, 'lib/ok.ts'), 'export const ok = 1\n')
  await writeFile(join(root, 'routes/index.stator'), route)
}

afterEach(() => mock.restoreAll())
after(() => rm(root, { recursive: true, force: true }))

describe('stator check: how island scripts use machine modules', () => {
  const MACHINE = (name: string, extra = '', reads = '') =>
    `import { defineMachine } from '@statorjs/stator/machine'\n${extra}\n` +
    `export default defineMachine({\n  name: '${name}',\n  lifecycle: 'session',\n${reads}` +
    "  events: {} as { type: 'ADD' },\n  context: { n: 0 },\n  initial: 'idle',\n" +
    '  states: { idle: { on: { ADD: (ctx) => { ctx.n += 1 } } } },\n  selectors: {},\n})\n'
  const ISLAND = (script: string, body: string) =>
    '<cart-panel><button type="button" on:click={go}>go</button></cart-panel>\n\n' +
    `<script>\n${script}\n  export class CartPanel extends StatorElement {\n${body}\n  }\n</script>\n`

  async function app(files: Record<string, string>): Promise<void> {
    await scaffold("---\nimport Panel from '../templates/cart-panel.stator'\n---\n<Panel />\n")
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    }
  }
  const errorsOf = async (): Promise<string> => {
    const stderr = mock.method(process.stderr, 'write', () => true)
    mock.method(process.stdout, 'write', () => true)
    await assert.rejects(checkStack(root), /typecheck failed with \d+ error/)
    return stderr.mock.calls.map((c) => String(c.arguments[0])).join('')
  }

  it('passes an island that runs one machine and dispatches to another', async () => {
    await app({
      'machines/cart.ts': MACHINE('CartMachine'),
      'shared/draft.ts': MACHINE('Draft'),
      'templates/cart-panel.stator': ISLAND(
        "  import Draft from '../shared/draft.ts'\n  import Cart from '../machines/cart.ts'",
        "    draft = use(Draft)\n    go() { void dispatch(Cart, { type: 'ADD' }) }",
      ),
    })
    mock.method(process.stdout, 'write', () => true)
    assert.equal(await checkStack(root), undefined)
  })

  it('fails a machine import the script uses in a way that says neither, located', async () => {
    await app({
      'machines/cart.ts': MACHINE('CartMachine'),
      'templates/cart-panel.stator': ISLAND(
        "  import Cart from '../machines/cart.ts'",
        '    go() { console.log([Cart]) }',
      ),
    })
    const out = await errorsOf()
    assert.match(out, /templates\/cart-panel\.stator:6 uses the machine import "Cart"/)
    assert.match(out, /Pass it straight to use\(\) to run it in the browser, or to dispatch\(\)/)
  })

  it('fails a server-pinned machine passed to use(), naming what pins it', async () => {
    await app({
      'machines/prices.ts': MACHINE('Prices'),
      'machines/cart.ts': MACHINE(
        'CartMachine',
        "import Prices from './prices.ts'\n",
        '  reads: [Prices],\n',
      ),
      'templates/cart-panel.stator': ISLAND(
        "  import Cart from '../machines/cart.ts'",
        '    cart = use(Cart)\n    go() {}',
      ),
    })
    const out = await errorsOf()
    assert.match(out, /passes "CartMachine" from machines\/cart\.ts to use\(\)/)
    assert.match(out, /server-pinned: it reads machine "Prices"/)
  })

  it('fails a script that takes server code from @statorjs/stator/server', async () => {
    await app({
      'templates/cart-panel.stator': ISLAND(
        "  import { sessionStore } from '@statorjs/stator/server'",
        '    go() { void sessionStore }',
      ),
    })
    const out = await errorsOf()
    assert.match(
      out,
      /templates\/cart-panel\.stator is bundled for the browser and imports "sessionStore"/,
    )
  })
})

describe('stator check: an island template is typechecked', () => {
  const island = (fallback: string) =>
    '<qty-badge>\n' +
    '  <ul>{props.rows.map((row) => <li>{row.name}</li>)}</ul>\n' +
    `  <span>{read(qty, (q) => q.count, ${fallback})}</span>\n` +
    '</qty-badge>\n\n' +
    '<script>\n  const Qty = machine({ count: 1 })\n' +
    '  export class QtyBadge extends StatorElement {\n    qty = use(Qty)\n  }\n</script>\n'
  const app = async (fallback: string): Promise<void> => {
    await scaffold("---\nimport Badge from '../templates/qty-badge.stator'\n---\n<Badge />\n")
    await mkdir(join(root, 'templates'), { recursive: true })
    await writeFile(join(root, 'templates/qty-badge.stator'), island(fallback))
    // An app's tsconfig: the generated check files are part of the program.
    const config = JSON.parse(tsconfig)
    config.compilerOptions = {
      ...config.compilerOptions,
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      allowImportingTsExtensions: true,
      jsx: 'preserve',
      rootDirs: ['.', '.stator/types', '.stator/check'],
    }
    config.include = ['lib', '.stator/check/**/*.tsx']
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config))
  }

  it('passes a client read whose selector takes no argument', async () => {
    await app('1')
    const file = join(root, 'templates/qty-badge.stator')
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(file, 'utf8')
    await writeFile(file, source.replace('(q) => q.count', '() => 1'))
    mock.method(process.stdout, 'write', () => true)
    assert.equal(await checkStack(root), undefined)
  })

  it('passes a sound template, callbacks over untyped props included', async () => {
    await app('1')
    mock.method(process.stdout, 'write', () => true)
    assert.equal(await checkStack(root), undefined)
  })

  it('fails a mistyped read fallback, located in the .stator source', async () => {
    await app("'one'")
    const stderr = mock.method(process.stderr, 'write', () => true)
    mock.method(process.stdout, 'write', () => true)
    await assert.rejects(checkStack(root), /typecheck failed with 1 error/)
    const out = stderr.mock.calls
      .map((c) => String(c.arguments[0]))
      .join('')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips tsc's colour codes
      .replace(/\x1b\[\d+m/g, '')
    assert.match(out, /templates\/qty-badge\.stator:3:36/)
    assert.match(out, /'string' is not assignable to parameter of type 'number'/)
  })
})

describe('stator check: the compiler runs over every .stator file', () => {
  it('a template the dev server would reject fails check, located', async () => {
    await scaffold(`---\nconst { x } = Stator.props<{ x: string }>()\n---\n<p>{x}</p>\n`)
    const stderr = mock.method(process.stderr, 'write', () => true)

    await assert.rejects(checkStack(root), /typecheck failed with 1 error/)
    const out = stderr.mock.calls.map((c) => String(c.arguments[0])).join('')
    assert.ok(out.includes('routes/index.stator:2:'))
    assert.ok(out.includes('Stator.props() is not available in a route page'))
    assert.ok(out.includes('^'))
  })

  it('a sound app passes', async () => {
    await scaffold(`---\nconst title = 'hi'\n---\n<p>{title}</p>\n`)
    mock.method(process.stdout, 'write', () => true)
    assert.equal(await checkStack(root), undefined)
  })

  it('a computed event type warns that it leaves the route open, and still passes', async () => {
    await scaffold(
      "---\nconst kind = 'A' as string\nconst m = { send: (e: object) => e }\n---\n" +
        '<button on:click={() => m.send({ type: kind })}>go</button>\n',
    )
    const stderr = mock.method(process.stderr, 'write', () => true)
    mock.method(process.stdout, 'write', () => true)

    assert.equal(await checkStack(root), undefined)
    const err = stderr.mock.calls.map((c) => String(c.arguments[0])).join('')
    assert.match(
      err,
      /routes\/index\.stator:1 - warning: an event is sent with a type the build cannot read, so routes\/index\.stator accepts every event its machines handle/,
    )
  })

  it('a raw() script string warns, located, and still passes', async () => {
    await scaffold(
      '---\nconst json = \'{}\'\n---\n<p>{raw(`<script type="speculationrules">${json}</script>`)}</p>\n',
    )
    const stderr = mock.method(process.stderr, 'write', () => true)
    const stdout = mock.method(process.stdout, 'write', () => true)

    assert.equal(await checkStack(root), undefined)
    const err = stderr.mock.calls.map((c) => String(c.arguments[0])).join('')
    assert.ok(err.includes('routes/index.stator:4:9 - warning: <script> built as a string'))
    assert.ok(
      stdout.mock.calls
        .map((c) => String(c.arguments[0]))
        .join('')
        .includes(', 1 warning\n'),
    )
  })

  it('a plain conditional on a machine snapshot warns, located, and still passes', async () => {
    await scaffold(
      "---\nimport Door from '../machines/door.ts'\nconst [door] = Stator.reads([Door])\n" +
        'const open = door.isOpen\n---\n' +
        "<p>{open ? <button on:click={() => door.send({ type: 'SHUT' })}>shut</button> : <b>shut</b>}</p>\n",
    )
    await mkdir(join(root, 'machines'), { recursive: true })
    await writeFile(
      join(root, 'machines/door.ts'),
      "import { defineMachine } from '@statorjs/stator/machine'\n" +
        "export default defineMachine({\n  name: 'Door',\n  lifecycle: 'session',\n" +
        "  events: {} as { type: 'SHUT' },\n  context: { open: true },\n  initial: 'idle',\n" +
        '  states: { idle: { on: { SHUT: (ctx) => { ctx.open = false } } } },\n' +
        '  selectors: { isOpen: (ctx) => ctx.open },\n})\n',
    )
    const stderr = mock.method(process.stderr, 'write', () => true)
    const stdout = mock.method(process.stdout, 'write', () => true)

    assert.equal(await checkStack(root), undefined)
    const err = stderr.mock.calls.map((c) => String(c.arguments[0])).join('')
    assert.ok(
      err.includes(
        'routes/index.stator:6:5 - warning: this branch is chosen once, when the page renders. ' +
          'If `open` changes later',
      ),
    )
    assert.ok(err.includes('Use when(read(door, (d) => d.isOpen), …)'))
    assert.ok(
      stdout.mock.calls
        .map((c) => String(c.arguments[0]))
        .join('')
        .includes(', 1 warning\n'),
    )
  })
})

describe('stator check: global HTML attributes on plain elements', () => {
  const app = async (route: string): Promise<void> => {
    await scaffold(route)
    const config = JSON.parse(tsconfig)
    config.compilerOptions = {
      ...config.compilerOptions,
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      allowImportingTsExtensions: true,
      jsx: 'preserve',
      rootDirs: ['.', '.stator/types', '.stator/check'],
    }
    config.include = ['lib', '.stator/check/**/*.tsx']
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config))
  }
  const errorsOf = async (): Promise<string> => {
    const stderr = mock.method(process.stderr, 'write', () => true)
    mock.method(process.stdout, 'write', () => true)
    await assert.rejects(checkStack(root), /typecheck failed with 1 error/)
    return (
      stderr.mock.calls
        .map((c) => String(c.arguments[0]))
        .join('')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strips tsc's colour codes
        .replace(/\x1b\[\d+m/g, '')
    )
  }

  it('passes schema.org microdata and the other globals', async () => {
    await app(
      "---\nconst url = 'https://example.com/a'\n---\n" +
        '<article itemscope itemtype="https://schema.org/BlogPosting" itemid={url} itemref="author">\n' +
        '  <h1 itemprop="headline" translate="no" spellcheck="false">Hi</h1>\n' +
        '  <time itemprop="datePublished" datetime="2026-11-15">Nov 15</time>\n' +
        '  <div contenteditable="plaintext-only" enterkeyhint="send" inputmode="text" autocapitalize="sentences" accesskey="e" autofocus></div>\n' +
        '  <section inert part="body" slot="main" nonce="abc" is="x-section" exportparts="a, b" writingsuggestions="false" autocorrect="off"></section>\n' +
        '</article>\n',
    )
    mock.method(process.stdout, 'write', () => true)
    assert.equal(await checkStack(root), undefined)
  })

  it('fails a non-boolean itemscope, located', async () => {
    await app('---\n---\n<div itemscope={42}></div>\n')
    const out = await errorsOf()
    assert.match(out, /routes\/index\.stator:3:/)
    assert.match(out, /'number' is not assignable/)
  })

  it('fails an enumerated attribute set to false', async () => {
    await app('---\n---\n<p translate={false}>Hi</p>\n')
    assert.match(await errorsOf(), /routes\/index\.stator:3:/)
  })
})

describe('stator check: events sent to app machines', () => {
  const MACHINE = (lifecycle: string) =>
    "import { defineMachine } from '@statorjs/stator/machine'\n" +
    `export default defineMachine({\n  name: 'Tally',\n  lifecycle: '${lifecycle}',\n` +
    "  events: {} as { type: 'BUMP' },\n  context: { n: 0 },\n  initial: 'idle',\n" +
    '  states: { idle: { on: { BUMP: (ctx) => { ctx.n += 1 } } } },\n' +
    '  selectors: { n: (ctx) => ctx.n },\n})\n'
  const ROUTE =
    "---\nimport Tally from '../machines/tally.ts'\nconst [tally] = Stator.reads([Tally])\n---\n" +
    "<p>{read(tally, (t) => t.n)}</p>\n<button on:click={() => tally.send({ type: 'BUMP' })}>bump</button>\n"
  const ISLAND =
    '<bump-button><button type="button" on:click={go}>go</button></bump-button>\n\n' +
    "<script>\n  import Tally from '../machines/tally.ts'\n" +
    "  export class BumpButton extends StatorElement {\n    go() { void dispatch(Tally, { type: 'BUMP' }) }\n  }\n</script>\n"

  // A scaffolded app's tsconfig: unlike the one above, it typechecks templates.
  const APP_TSCONFIG = JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      rootDirs: ['.', '.stator/types', '.stator/check'],
      jsx: 'preserve',
      types: [],
    },
    include: ['**/*.ts', '**/*.stator', '.stator/check/**/*.tsx'],
  })

  async function app(lifecycle: string, route: string, files: Record<string, string> = {}) {
    await scaffold(route)
    await writeFile(join(root, 'tsconfig.json'), APP_TSCONFIG)
    await mkdir(join(root, 'machines'), { recursive: true })
    await writeFile(join(root, 'machines/tally.ts'), MACHINE(lifecycle))
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    }
  }
  const errorsOf = async (): Promise<string> => {
    const stderr = mock.method(process.stderr, 'write', () => true)
    mock.method(process.stdout, 'write', () => true)
    await assert.rejects(checkStack(root), /typecheck failed with 1 error/)
    return stderr.mock.calls.map((c) => String(c.arguments[0])).join('')
  }

  it('fails a template send to an app machine, located, naming the session relay', async () => {
    await app('app', ROUTE)
    const out = await errorsOf()
    assert.match(out, /routes\/index\.stator.*6/)
    assert.match(out, /An app machine takes no events from the browser/)
  })

  it('fails an island dispatch to an app machine', async () => {
    await app('app', "---\nimport Bump from '../templates/bump-button.stator'\n---\n<Bump />\n", {
      'templates/bump-button.stator': ISLAND,
    })
    const out = await errorsOf()
    assert.match(out, /templates\/bump-button\.stator/)
    assert.match(out, /An app machine takes no events from the browser/)
  })

  it('passes the same send to a session machine', async () => {
    await app('session', ROUTE)
    mock.method(process.stdout, 'write', () => true)
    assert.equal(await checkStack(root), undefined)
  })
})
