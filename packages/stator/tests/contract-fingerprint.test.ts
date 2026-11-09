// @env happy-dom
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type ContractRecord,
  type ContractSurface,
  contractSurface,
  fingerprintOf,
  readRecord,
  refreshRecord,
  surfaceDiff,
} from '../scripts/contract-surface.ts'
import { COMPILED_CONTRACT } from '../src/compiler/contract.ts'

/**
 * The compiled-shape contract gate. `COMPILED_CONTRACT` and the recorded
 * fingerprint move together or not at all: a compiler change that moves the
 * surface fails here until the number is bumped and `pnpm contract:refresh`
 * recorded it, and a runtime that stops exporting a name compiled output
 * imports fails the same way.
 */

const RUNTIME: Record<string, () => Promise<Record<string, unknown>>> = {
  '@statorjs/stator/template': () => import('../src/template/index.ts'),
  '@statorjs/stator/client': () => import('../src/client/index.ts'),
  '@statorjs/stator/server': () => import('../src/server/index.ts'),
}

describe('compiled-shape contract', () => {
  const record = readRecord()
  const last = record.at(-1)!
  const surface = contractSurface()

  it('the record ends at the current COMPILED_CONTRACT', () => {
    assert.equal(
      last.contract,
      COMPILED_CONTRACT,
      `COMPILED_CONTRACT is ${COMPILED_CONTRACT} but the record ends at ${last.contract}: run \`pnpm contract:refresh\` in packages/stator.`,
    )
  })

  it('the compiled surface matches the record for this contract', () => {
    const diff = surfaceDiff(last, surface)
    assert.equal(
      fingerprintOf(surface),
      last.fingerprint,
      `the compiled-shape contract changed: bump COMPILED_CONTRACT in src/compiler/contract.ts and run \`pnpm contract:refresh\` in packages/stator.\n${diff.join('\n')}`,
    )
  })

  it('the runtime still exports every name this contract imports', async () => {
    for (const [spec, names] of Object.entries(last.imports)) {
      const load = RUNTIME[spec]
      assert.ok(load, `no runtime module known for ${spec}`)
      const exported = await load()
      const missing = names.filter((n) => !(n in exported))
      assert.deepStrictEqual(
        missing,
        [],
        `${spec} no longer exports ${missing.join(', ')}, which contract ${last.contract} output imports: bump COMPILED_CONTRACT and run \`pnpm contract:refresh\`.`,
      )
    }
  })
})

describe('refreshing the record', () => {
  const base: ContractSurface = {
    imports: { '@statorjs/stator/template': ['html'] },
    markers: ['a'],
  }
  const moved: ContractSurface = { ...base, markers: ['a', 'b'] }
  const start: ContractRecord[] = [{ contract: 1, fingerprint: fingerprintOf(base), ...base }]

  it('leaves the record alone when nothing moved', () => {
    assert.equal(refreshRecord(start, 1, base), start)
  })

  it('refuses a moved surface without a bump, showing what moved', () => {
    assert.throws(() => refreshRecord(start, 1, moved), /COMPILED_CONTRACT is still 1[\s\S]*\+ b/)
  })

  it('refuses a bump without a moved surface', () => {
    assert.throws(() => refreshRecord(start, 2, base), /surface did not change/)
  })

  it('refuses a bump by more than one', () => {
    assert.throws(() => refreshRecord(start, 3, moved), /bump it by one/)
  })

  it('appends an entry for a bump with a moved surface', () => {
    const next = refreshRecord(start, 2, moved)
    assert.equal(next.length, 2)
    assert.equal(next[1]!.contract, 2)
    assert.equal(next[1]!.fingerprint, fingerprintOf(moved))
  })
})
