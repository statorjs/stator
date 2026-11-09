import assert from 'node:assert/strict'
import { cp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { run as buildLib } from '../src/cli/commands/build-lib.ts'
import { checkStack, run as runCheck } from '../src/cli/commands/check.ts'

/**
 * `stator check src` on a component library: a server component importing
 * `../server/greeting.ts` and a sibling island, the island's `<script>` and
 * its template wiring both typechecked, errors reported at `.stator` lines.
 * The fixture is copied beside the tests so `@statorjs/stator` resolves.
 */

const here = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(here, 'fixtures/check-lib')
const root = resolve(here, '.tmp-check-lib')
const counter = join(root, 'src/components/counter.stator')

function capture(): { err: () => string; out: () => string } {
  const stderr = mock.method(process.stderr, 'write', () => true)
  const stdout = mock.method(process.stdout, 'write', () => true)
  const text = (m: typeof stderr) =>
    stripVTControlCharacters(m.mock.calls.map((c) => String(c.arguments[0])).join(''))
  return { err: () => text(stderr), out: () => text(stdout) }
}

async function fix(): Promise<void> {
  const source = await readFile(counter, 'utf8')
  await writeFile(
    counter,
    source
      .replace('const label: number =', 'const label: string =')
      .replace('reset(to: number)', 'reset()')
      .replace('this.count = to', 'this.count = 0'),
  )
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  )

beforeEach(async () => {
  await rm(root, { recursive: true, force: true })
  await cp(fixture, root, { recursive: true })
})
afterEach(() => mock.restoreAll())
after(() => rm(root, { recursive: true, force: true }))

describe('stator check on a component library', () => {
  it("fails naming the island's script error and its wiring error at .stator lines", async () => {
    const io = capture()
    await assert.rejects(checkStack(root, { dir: 'src' }), /typecheck failed with 2 errors/)
    const err = io.err()
    assert.ok(
      err.includes(
        "src/components/counter.stator:12:13 - error TS2322: Type 'string' is not assignable to type 'number'.",
      ),
      err,
    )
    assert.ok(
      err.includes('src/components/counter.stator:3:11 - error TS2352: Conversion of type'),
      err,
    )
    assert.ok(err.includes('3   <output on:click={reset}></output>'), err)
    assert.ok(!err.includes('.check.tsx'), err)
    assert.ok(io.out().includes('no src/routes/ — contract check skipped'))
  })

  it('passes once the island is fixed', async () => {
    await fix()
    const io = capture()
    assert.equal(await checkStack(root, { dir: 'src' }), undefined)
    assert.match(io.out(), /stator check: ok — 2 \.stator\.d\.ts/)
  })

  it('`stator check src --routes <dir>` walks the given routes', async () => {
    await fix()
    const io = capture()
    await runCheck({ root, rest: ['src'], routesDir: 'src/components' })
    assert.ok(!io.out().includes('contract check skipped'), io.out())
  })

  it('writes the generated files under the root, mirroring src/', async () => {
    capture()
    await checkStack(root, { dir: 'src' }).catch(() => {})
    assert.ok(await exists(join(root, '.stator/types/src/components/card.stator.d.ts')))
    assert.ok(await exists(join(root, '.stator/check/src/components/card.stator.check.tsx')))
    assert.ok(
      await exists(join(root, '.stator/check/src/components/counter.stator.client.check.tsx')),
    )
  })
})

describe('stator build:lib checks first', () => {
  const ctx = () => ({ root, rest: ['src'] })

  it('refuses the broken library and compiles nothing', async () => {
    capture()
    await assert.rejects(buildLib(ctx()), /typecheck failed/)
    assert.equal(await exists(`${counter}.ts`), false)
    assert.equal(await exists(`${counter}.client.ts`), false)
  })

  it('compiles the fixed library, reporting the check first', async () => {
    await fix()
    const io = capture()
    await buildLib(ctx())
    const out = io.out()
    assert.ok(out.indexOf('stator check: ok') < out.indexOf('stator build:lib: 2 components'), out)
    assert.ok(await exists(`${counter}.client.ts`))
  })
})
