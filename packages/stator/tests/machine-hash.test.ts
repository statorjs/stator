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
