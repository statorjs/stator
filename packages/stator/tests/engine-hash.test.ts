import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { engineHash, hashMachines } from '../src/server/machine-hash.ts'

/**
 * The engine hash: the framework's contribution to every machine hash. It is
 * a measurement of the engine and the actor host — not the package version —
 * so a release that touches only the compiler, CLI, renderer or editor
 * tooling leaves sessions alone. The two lists below are PINNED on purpose:
 * a new import edge in this closure must be a deliberate call (bundle it
 * because it executes as part of a machine, or cut it because it is plumbing).
 */

const BUNDLED = [
  'engine/actor.ts',
  'engine/define-machine.ts',
  'engine/index.ts',
  'engine/types.ts',
  'server/app-dispatch.ts',
  'server/app-store.ts',
  'server/define-machine.ts',
  'server/dispatch-context.ts',
  'server/effects.ts',
  'server/instance-proxy.ts',
  'server/machine-hash.ts',
  'server/machine-store.ts',
  'server/reads-helpers.ts',
  'server/session-lock.ts',
  'server/session-runtime.ts',
  'server/session.ts',
  'server/snapshot-policy.ts',
  'server/timers.ts',
]

const CUT = ['engine/describe.ts', 'server/logger.ts', 'server/render-context.ts', 'server/sse.ts']

describe('engine hash', () => {
  it('is a deterministic sha256 computed once per process', async () => {
    const a = await engineHash()
    const b = await engineHash()
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(b).toBe(a)
  })

  it('bundles exactly the engine and the actor host', async () => {
    expect((await engineHash()).inputs).toEqual(BUNDLED)
  })

  it('cuts exactly the plumbing the closure reaches', async () => {
    expect((await engineHash()).cut).toEqual(CUT)
  })

  it('never bundles the compiler, CLI, build, dev servers, renderer or the HTTP layer', async () => {
    const { inputs } = await engineHash()
    const forbidden =
      /^(compiler|cli|build|dev|template|wire|client)\/|^server\/(http|render|routing|dev-|create-app|images|sse)/
    for (const r of inputs) expect(r).not.toMatch(forbidden)
  })

  it('is an input to every machine hash', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'stator-engine-hash-')))
    try {
      const dir = join(root, 'machines')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'plain.ts'),
        `import { defineMachine } from '@statorjs/stator/server'
export default defineMachine({ name: 'Plain', context: { n: 0 }, initial: 'idle', states: { idle: {} } })
`,
      )
      const res = (await hashMachines([join(dir, 'plain.ts')], { machinesDir: dir })).get(
        join(dir, 'plain.ts'),
      )!
      expect(res.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(res.packages).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
