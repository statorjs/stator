import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashMachines } from '../src/server/machine-hash.ts'

/**
 * The per-machine code hash: moves exactly when code that can execute as part
 * of the machine changes — in the machine file or in any module it reaches —
 * and for nothing else. Each case below is one row of the spec's contract.
 */

let root = ''
const machinesDir = () => join(root, 'machines')
const write = async (rel: string, content: string) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content)
}

const LIB = `
export const MAX = 3
export function within(n: number): boolean { return n < MAX }
export function unused(): string { return 'nobody imports me' }
`
const CART = (guard = 'within(ctx.items.length)', defaultItems = '[]') => `
import { defineMachine } from '@statorjs/stator/server'
import { within } from '../lib/rules.ts'
// A comment the hash must ignore.
export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  events: {} as { type: 'ADD' },
  context: { items: ${defaultItems} as string[] },
  initial: 'idle',
  states: { idle: { on: { ADD: { when: (ctx) => ${guard}, do: (ctx) => { ctx.items.push('x') } } } } },
})
`
const AUDIT = (marker = 'a') => `
import { defineMachine } from '@statorjs/stator/server'
import Cart from './cart.ts'
export default defineMachine({
  name: 'AuditMachine',
  lifecycle: 'app',
  events: {} as { type: 'NOTE' },
  subscribes: [{ from: Cart, event: 'ADDED', dispatch: 'NOTE' }],
  context: { marker: '${marker}' },
  initial: 'ready',
  states: { ready: {} },
})
`

const hashAll = async () =>
  hashMachines([join(machinesDir(), 'cart.ts'), join(machinesDir(), 'audit.ts')], {
    machinesDir: machinesDir(),
  })
const cartHash = async () => (await hashAll()).get(join(machinesDir(), 'cart.ts'))!

beforeAll(async () => {
  // realpath: esbuild reports real paths (macOS /var → /private/var) and so does `inputs`.
  root = realpathSync(await mkdtemp(join(tmpdir(), 'stator-hash-')))
  await write('lib/rules.ts', LIB)
  await write('machines/cart.ts', CART())
  await write('machines/audit.ts', AUDIT())
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe('machine code hash', () => {
  it('is deterministic for unchanged code', async () => {
    const a = await cartHash()
    const b = await cartHash()
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(b.hash).toBe(a.hash)
  })

  it('ignores comments and whitespace', async () => {
    const before = (await cartHash()).hash
    await write(
      'machines/cart.ts',
      `// new header comment\n\n${CART().replace('  name:', '    name:')}`,
    )
    expect((await cartHash()).hash).toBe(before)
    await write('machines/cart.ts', CART())
  })

  it('changes when a guard body changes', async () => {
    const before = (await cartHash()).hash
    await write('machines/cart.ts', CART('ctx.items.length < 5'))
    expect((await cartHash()).hash).not.toBe(before)
    await write('machines/cart.ts', CART())
  })

  it('changes when a context default changes', async () => {
    const before = (await cartHash()).hash
    await write('machines/cart.ts', CART(undefined, "['seeded']"))
    expect((await cartHash()).hash).not.toBe(before)
    await write('machines/cart.ts', CART())
  })

  it('changes when a USED export of an imported module changes', async () => {
    const before = (await cartHash()).hash
    await write('lib/rules.ts', LIB.replace('MAX = 3', 'MAX = 4'))
    expect((await cartHash()).hash).not.toBe(before)
    await write('lib/rules.ts', LIB)
  })

  it('does not change when an UNUSED export of an imported module changes', async () => {
    const before = (await cartHash()).hash
    await write('lib/rules.ts', LIB.replace("'nobody imports me'", "'still nobody'"))
    expect((await cartHash()).hash).toBe(before)
    await write('lib/rules.ts', LIB)
  })

  it('changes when a sibling machine it imports changes (siblings are part of the closure)', async () => {
    const all = await hashAll()
    const auditBefore = all.get(join(machinesDir(), 'audit.ts'))!.hash
    const cartBefore = all.get(join(machinesDir(), 'cart.ts'))!.hash
    await write('machines/cart.ts', CART('ctx.items.length < 9'))
    const after = await hashAll()
    expect(after.get(join(machinesDir(), 'cart.ts'))!.hash).not.toBe(cartBefore)
    // Audit imports Cart for identity only, but a sibling import may also carry
    // values (a default mirrored into context) — so the importer resets too.
    expect(after.get(join(machinesDir(), 'audit.ts'))!.hash).not.toBe(auditBefore)
    await write('machines/cart.ts', CART())
  })

  it('reports the bundled inputs — the machine, its app modules and siblings, not packages', async () => {
    const all = await hashAll()
    const cart = all.get(join(machinesDir(), 'cart.ts'))!
    expect(cart.inputs).toContain(join(machinesDir(), 'cart.ts'))
    expect(cart.inputs).toContain(join(root, 'lib/rules.ts'))
    const audit = all.get(join(machinesDir(), 'audit.ts'))!
    expect(audit.inputs).toContain(join(machinesDir(), 'cart.ts'))
    expect(audit.inputs.some((p) => p.includes('node_modules'))).toBe(false)
  })

  it('lists an imported module even when its only used export is an inlined constant', async () => {
    await write('lib/step.ts', 'export const STEP = 1\n')
    await write(
      'machines/stepper.ts',
      `import { defineMachine } from '@statorjs/stator/server'
import { STEP } from '../lib/step.ts'
export default defineMachine({ name: 'Stepper', context: { n: 0 }, initial: 'idle', states: { idle: { on: { ADD: (ctx: { n: number }) => { ctx.n += STEP } } } } })
`,
    )
    const res = await hashMachines([join(machinesDir(), 'stepper.ts')], {
      machinesDir: machinesDir(),
    })
    const entry = res.get(join(machinesDir(), 'stepper.ts'))!
    expect(entry.inputs).toContain(join(root, 'lib/step.ts'))
    await write('lib/step.ts', 'export const STEP = 2\n')
    expect(
      (await hashMachines([join(machinesDir(), 'stepper.ts')], { machinesDir: machinesDir() })).get(
        join(machinesDir(), 'stepper.ts'),
      )!.hash,
    ).not.toBe(entry.hash)
    await rm(join(machinesDir(), 'stepper.ts'))
  })

  it('throws, naming the machine, when a closure cannot be bundled', async () => {
    await write(
      'machines/broken.ts',
      `import { nope } from '../lib/missing.ts'\nexport default nope`,
    )
    await expect(
      hashMachines([join(machinesDir(), 'broken.ts')], { machinesDir: machinesDir() }),
    ).rejects.toThrow(/cannot hash machine closure[\s\S]*missing\.ts/)
    await rm(join(machinesDir(), 'broken.ts'))
  })
})

/**
 * Packages: never bundled, but their installed versions are hash inputs for the
 * machines that reach them. A chart re-exported from a package bundles to one
 * line of re-export, so without this a package bump that rewrote its guards
 * would never reset its sessions.
 */
describe('machine code hash: packages', () => {
  const pkg = async (name: string, version: string, body = 'export const LIMIT = 3\n') => {
    await write(
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, version, type: 'module', main: 'index.js' }),
    )
    await write(`node_modules/${name}/index.js`, body)
  }
  const PKG_MACHINE = `
import { defineMachine } from '@statorjs/stator/server'
import { LIMIT } from '@acme/rules'
export default defineMachine({ name: 'Pkg', context: { n: 0 }, initial: 'idle', states: { idle: { on: { ADD: { when: (ctx: { n: number }) => ctx.n < LIMIT, do: (ctx: { n: number }) => { ctx.n++ } } } } } })
`
  const file = () => join(machinesDir(), 'pkg.ts')
  const one = async () =>
    (await hashMachines([file()], { machinesDir: machinesDir() })).get(file())!

  beforeAll(async () => {
    await pkg('@acme/rules', '1.0.0')
    await pkg('@acme/other', '1.0.0')
    await write('machines/pkg.ts', PKG_MACHINE)
  })
  afterAll(async () => {
    await rm(join(root, 'node_modules'), { recursive: true, force: true })
    await rm(file(), { force: true })
  })

  it('reports the packages a machine reaches, by name@version, and keeps them out of inputs', async () => {
    const res = await one()
    expect(res.packages).toEqual(['@acme/rules@1.0.0'])
    expect(res.inputs.some((p) => p.includes('node_modules'))).toBe(false)
  })

  it("changes when an imported package's version changes", async () => {
    const before = (await one()).hash
    await pkg('@acme/rules', '1.1.0')
    const after = await one()
    expect(after.packages).toEqual(['@acme/rules@1.1.0'])
    expect(after.hash).not.toBe(before)
    await pkg('@acme/rules', '1.0.0')
    expect((await one()).hash).toBe(before)
  })

  it('does not change when a package it does not reach changes', async () => {
    const before = (await one()).hash
    await pkg('@acme/other', '9.9.9')
    expect((await one()).hash).toBe(before)
  })

  it("does not change when a package's code changes without a version bump (the version is the boundary)", async () => {
    const before = (await one()).hash
    await pkg('@acme/rules', '1.0.0', 'export const LIMIT = 99\n')
    expect((await one()).hash).toBe(before)
    await pkg('@acme/rules', '1.0.0')
  })

  it('leaves a machine that reaches no package with a package-free digest', async () => {
    const cart = await cartHash()
    expect(cart.packages).toEqual([])
  })

  it('bundles a bare specifier that resolves to app code through tsconfig paths', async () => {
    await write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '#rules': ['./lib/rules.ts'] } },
      }),
    )
    await write(
      'machines/aliased.ts',
      `import { defineMachine } from '@statorjs/stator/server'
import { within } from '#rules'
export default defineMachine({ name: 'Aliased', context: { n: 0 }, initial: 'idle', states: { idle: { on: { ADD: { when: (ctx: { n: number }) => within(ctx.n) } } } } })
`,
    )
    const aliased = () => join(machinesDir(), 'aliased.ts')
    const hashIt = async () =>
      (await hashMachines([aliased()], { machinesDir: machinesDir() })).get(aliased())!
    const before = await hashIt()
    expect(before.inputs).toContain(join(root, 'lib/rules.ts'))
    expect(before.packages).toEqual([])
    await write('lib/rules.ts', LIB.replace('MAX = 3', 'MAX = 4'))
    expect((await hashIt()).hash).not.toBe(before.hash)
    await write('lib/rules.ts', LIB)
    await rm(aliased())
    await rm(join(root, 'tsconfig.json'))
  })

  it('externalizes a package that is not installed without failing the hash', async () => {
    await write(
      'machines/missing-pkg.ts',
      `import { defineMachine } from '@statorjs/stator/server'
import { x } from 'not-installed-anywhere'
export default defineMachine({ name: 'Missing', context: { x }, initial: 'idle', states: { idle: {} } })
`,
    )
    const f = join(machinesDir(), 'missing-pkg.ts')
    const res = (await hashMachines([f], { machinesDir: machinesDir() })).get(f)!
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(res.packages).toEqual([])
    await rm(f)
  })
})
