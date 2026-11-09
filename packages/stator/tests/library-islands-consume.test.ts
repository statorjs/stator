import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildApp, type StatorManifest } from '../src/build/build.ts'
import { compileLibrary } from '../src/build/compile-library.ts'

/**
 * A consuming app reaching an island a package ships precompiled (spec
 * `library-islands-…`, step 4): the build bundles it, maps it to the routes
 * that reach it and folds its CSS in; it refuses a component compiled for
 * another contract, two islands defining one tag, and a package island
 * dispatching to a machine the app does not register; dev serves it. The
 * fixture lives under the package so `@statorjs/stator` resolves through its
 * self-link, and the package is compiled in place with `build:lib`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const base = resolve(here, 'fixtures/.tmp-consume-islands')
after(() => rmSync(base, { recursive: true, force: true }))

const MACHINE = `import { defineMachine } from '@statorjs/stator/server'

export default defineMachine({
  name: 'CounterMachine',
  lifecycle: 'session',
  events: {} as { type: 'INCREMENT' },
  context: { count: 0 },
  initial: 'idle',
  states: { idle: { on: { INCREMENT: (ctx) => { ctx.count += 1 } } } },
  selectors: {},
})
`

const ISLAND = `<count-stepper>
  <button type="button" on:click={bump}>+1</button>
</count-stepper>

<style>
  button { color: rebeccapurple; }
</style>

<script>
  import Counter from '../machines/counter.ts'

  export class CountStepper extends StatorElement {
    bump() {
      void dispatch(Counter, { type: 'INCREMENT' })
    }
  }
</script>
`

const ROUTE = `---
import Stepper from '@acme/blocks/stepper.stator'
---
<html><head><title>consume</title></head><body><Stepper /></body></html>
`

const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

let n = 0
/** A fresh app with `@acme/blocks` compiled into its node_modules. */
async function scaffold(app: Record<string, string> = {}): Promise<string> {
  const root = join(base, `app-${n++}`)
  rmSync(root, { recursive: true, force: true })
  const pkg = join(root, 'node_modules/@acme/blocks')
  write(pkg, {
    'package.json': JSON.stringify({
      name: '@acme/blocks',
      version: '1.0.0',
      type: 'module',
      exports: { './stepper.stator': './src/stepper.stator.ts' },
      peerDependencies: { '@statorjs/stator': '*' },
    }),
    'machines/counter.ts': MACHINE,
    'src/stepper.stator': ISLAND,
  })
  await compileLibrary({ root: pkg, dir: join(pkg, 'src') })
  write(root, {
    'package.json': JSON.stringify({ name: 'consumer', type: 'module' }),
    'routes/index.stator': ROUTE,
    'machines/counter.ts': MACHINE,
    ...app,
  })
  return root
}

const shellOf = (root: string) => join(root, 'node_modules/@acme/blocks/src/stepper.stator.ts')
const REL = '@acme/blocks/src/stepper.stator'

describe('an app consuming a package island', () => {
  it('bundles it, maps it to the route, and folds its CSS into the route sheet', async () => {
    const root = await scaffold()
    const outDir = join(root, 'dist')
    const result = await buildApp({ root, outDir })
    assert.equal(result.islands, 1)
    const manifest = JSON.parse(
      readFileSync(join(outDir, 'stator-manifest.json'), 'utf8'),
    ) as StatorManifest
    const url = manifest.islands[REL]
    assert.ok(url, JSON.stringify(manifest.islands))
    assert.match(url, /^\/static\/assets\/acme_blocks_src_stepper-/, 'no leading @ in the name')
    assert.deepStrictEqual(manifest.routes['routes/index.stator.ts'], [url])

    const bundle = readFileSync(join(outDir, url.replace(/^\//, '')), 'utf8')
    assert.ok(bundle.includes('count-stepper'), 'the custom element is in the bundle')
    assert.ok(bundle.includes('CounterMachine'), 'dispatches by name')
    assert.ok(!bundle.includes('lifecycle'), 'the machine body is not')

    const sheet = manifest.routeCss['routes/index.stator.ts']
    assert.ok(sheet)
    assert.match(readFileSync(join(outDir, sheet.replace(/^\//, '')), 'utf8'), /rebeccapurple/)
  })

  it('refuses a component compiled for another contract, naming the package', async () => {
    const root = await scaffold()
    const shell = shellOf(root)
    writeFileSync(
      shell,
      readFileSync(shell, 'utf8').replace(
        /contract=\d+ compiler=\S+/,
        'contract=99 compiler=9.0.0',
      ),
    )
    await assert.rejects(buildApp({ root, outDir: join(root, 'dist') }), (err: Error) => {
      assert.match(
        err.message,
        /@acme\/blocks\/src\/stepper\.stator\.ts was compiled for contract 99 \(by Stator 9\.0\.0\)/,
      )
      assert.match(err.message, /Install a version of @acme\/blocks built for this Stator/)
      return true
    })
  })

  it('refuses a component with no stamp, compiled before 3.0', async () => {
    const root = await scaffold()
    const shell = shellOf(root)
    writeFileSync(shell, readFileSync(shell, 'utf8').replace(/^\/\* @stator [^\n]*\n/, '\n'))
    await assert.rejects(
      buildApp({ root, outDir: join(root, 'dist') }),
      /carries no compiled-shape stamp/,
    )
  })

  it('refuses two islands defining one tag, naming both', async () => {
    const root = await scaffold({
      'routes/index.stator': ROUTE.replace(
        '---\n<html>',
        "import Local from '../templates/count-stepper.stator'\n---\n<html>",
      ).replace('<Stepper />', '<Stepper /><Local />'),
      'templates/count-stepper.stator':
        '<count-stepper><span>local</span></count-stepper>\n\n<script>\n  export class CountStepper extends StatorElement {}\n</script>\n',
    })
    await assert.rejects(buildApp({ root, outDir: join(root, 'dist') }), (err: Error) => {
      assert.match(
        err.message,
        /<count-stepper> is defined by both templates\/count-stepper\.stator and @acme\/blocks\/src\/stepper\.stator/,
      )
      return true
    })
  })

  it('refuses a package island dispatching to a machine the app does not register', async () => {
    const root = await scaffold()
    rmSync(join(root, 'machines'), { recursive: true })
    await assert.rejects(buildApp({ root, outDir: join(root, 'dist') }), (err: Error) => {
      assert.match(
        err.message,
        /the island @acme\/blocks\/src\/stepper\.stator dispatches to the machine "CounterMachine"/,
      )
      return true
    })
  })
})

/** Start `stator dev` in `root`; resolves with its base URL and output. */
async function startDev(
  root: string,
  port: number,
): Promise<{ child: ChildProcess; url: string; output: string[] }> {
  const bin = resolve(here, '../src/cli/stator.js')
  const child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, LOG_LEVEL: 'info', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output: string[] = []
  let bound = 0
  child.stdout!.on('data', (b) => {
    const s = String(b)
    output.push(s)
    const m = /localhost:(\d+)/.exec(s)
    if (m) bound = Number(m[1])
  })
  child.stderr!.on('data', (b) => output.push(String(b)))
  const deadline = Date.now() + 30_000
  while (!bound && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  assert.ok(bound, output.join(''))
  return { child, url: `http://localhost:${bound}`, output }
}

describe('stator dev with a package island', () => {
  const children: ChildProcess[] = []
  after(() => {
    for (const c of children) c.kill('SIGTERM')
  })

  it('injects its script and serves the bundle', async () => {
    const root = await scaffold()
    const dev = await startDev(root, 54000 + (process.pid % 3000))
    children.push(dev.child)
    const page = await (await fetch(`${dev.url}/`)).text()
    const src =
      /<script type="module" src="(\/static\/assets\/acme_blocks_src_stepper-[^"]+)"/.exec(
        page,
      )?.[1]
    assert.ok(src, page)
    const res = await fetch(`${dev.url}${src}`)
    assert.equal(res.status, 200)
    assert.ok((await res.text()).includes('count-stepper'))
    const css = /<link rel="stylesheet" href="([^"]+)"/.exec(page)?.[1]
    assert.ok(css, page)
    assert.match(await (await fetch(`${dev.url}${css}`)).text(), /rebeccapurple/)
  })

  it('logs a tag collision, naming both and the route, and serves the app island', async () => {
    const root = await scaffold({
      'routes/index.stator': ROUTE.replace(
        '---\n<html>',
        "import Local from '../templates/count-stepper.stator'\n---\n<html>",
      ).replace('<Stepper />', '<Stepper /><Local />'),
      'templates/count-stepper.stator':
        '<count-stepper><span>local</span></count-stepper>\n\n<script>\n  export class CountStepper extends StatorElement {}\n</script>\n',
    })
    const dev = await startDev(root, 57000 + (process.pid % 3000))
    children.push(dev.child)
    const page = await (await fetch(`${dev.url}/`)).text()
    assert.ok(!page.includes('acme_blocks_src_stepper-'), 'the package island is not served')
    assert.match(page, /src="\/static\/assets\/templates_count-stepper-/)
    const log = dev.output.join('')
    assert.match(
      log,
      /<count-stepper> is defined by both templates\/count-stepper\.stator and @acme\/blocks\/src\/stepper\.stator/,
    )
    assert.match(log, /routes\/index\.stator reaches @acme\/blocks\/src\/stepper\.stator/)
  })
})
