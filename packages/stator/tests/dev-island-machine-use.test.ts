import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * `stator dev` and an island that misuses a machine import: the error reaches
 * the developer on save, located in the `.stator` they wrote, while the last
 * good build keeps being served; fixing the file recovers; and a server
 * started on a broken island says why instead of serving it. Its own fixture,
 * since it breaks the app on purpose.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/.tmp-dev-machine-use-app')
const bin = resolve(here, '../src/cli/stator.js')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const MACHINE = `import { defineMachine } from '@statorjs/stator/machine'

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

const island = (extra = '') => `<count-stepper>
  <button type="button" on:click={bump}>+1</button>
</count-stepper>

<script>
  import Counter from '../machines/counter.ts'
${extra}
  export class CountStepper extends StatorElement {
    bump() {
      void dispatch(Counter, { type: 'INCREMENT' })
    }
  }
</script>
`
const MISUSE = '  const all = [Counter]\n  void all\n'

const ROUTE = `---
import Stepper from '../templates/count-stepper.stator'
---
<html><head><title>machine-use</title></head><body><Stepper /></body></html>
`

async function scaffold(islandSource: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
  for (const [path, text] of Object.entries({
    'package.json': JSON.stringify({ name: 'dev-machine-use', type: 'module' }),
    'routes/index.stator': ROUTE,
    'machines/counter.ts': MACHINE,
    'templates/count-stepper.stator': islandSource,
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
}

interface Dev {
  child: ChildProcess
  output: string[]
  exited: Promise<number | null>
}

function startDev(port: number): Dev {
  const output: string[] = []
  const child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, LOG_LEVEL: 'info', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', (b) => output.push(String(b)))
  child.stderr!.on('data', (b) => output.push(String(b)))
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)))
  return { child, output, exited }
}

const settle = async (ok: () => boolean, tries = 100): Promise<boolean> => {
  for (let i = 0; i < tries && !ok(); i++) await sleep(150)
  return ok()
}

describe('stator dev: an island that misuses a machine import', () => {
  let dev: Dev | undefined
  let base = ''
  const file = join(root, 'templates/count-stepper.stator')
  const seen = (text: string) => (dev?.output.join('') ?? '').includes(text)

  before(
    async () => {
      await scaffold(island())
      dev = startDev(54000 + (process.pid % 3000))
      const bound = () => /localhost:(\d+)/.exec(dev!.output.join(''))?.[1]
      assert.equal(await settle(() => bound() !== undefined, 200), true, dev.output.join(''))
      base = `http://localhost:${bound()}`
      for (let i = 0; i < 200; i++) {
        try {
          if ((await fetch(`${base}/`)).status === 200) return
        } catch {
          // not listening yet
        }
        await sleep(50)
      }
      throw new Error(`dev server did not answer:\n${dev.output.join('')}`)
    },
    { timeout: 40_000 },
  )

  after(async () => {
    dev?.child.kill()
    await rm(root, { recursive: true, force: true })
  })

  it('reports it on save, located in the .stator, and keeps serving the last good build', {
    timeout: 30_000,
  }, async () => {
    await writeFile(file, island(MISUSE))
    const reported = () =>
      seen('reload failed') &&
      seen('templates/count-stepper.stator:7 uses the machine import "Counter"') &&
      seen('in a way the build cannot place')
    assert.equal(await settle(reported), true, dev!.output.join(''))
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    assert.ok((await res.text()).includes('<count-stepper'))
  })

  it('recovers when the file is fixed', { timeout: 30_000 }, async () => {
    const before = dev!.output.length
    await writeFile(file, island())
    assert.equal(
      await settle(() => dev!.output.slice(before).join('').includes('reloaded')),
      true,
      dev!.output.join(''),
    )
  })
})

describe('stator dev: started on an island that misuses a machine import', () => {
  after(() => rm(root, { recursive: true, force: true }))

  it('says why instead of serving it', { timeout: 40_000 }, async () => {
    await scaffold(island(MISUSE))
    const dev = startDev(57000 + (process.pid % 3000))
    try {
      const said = () => dev.output.join('').includes('in a way the build cannot place')
      assert.equal(await settle(said, 200), true, dev.output.join(''))
      assert.ok(dev.output.join('').includes('templates/count-stepper.stator:7'))
    } finally {
      dev.child.kill()
    }
  })
})
