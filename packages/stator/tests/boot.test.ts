import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { discoverBoot, runBoot } from '../src/server/boot.ts'
import { createApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const bootDir = resolve(here, 'fixtures/boot')

describe('discoverBoot', () => {
  it('returns undefined when there is no boot file', async () => {
    assert.equal(await discoverBoot(resolve(bootDir, 'nope.ts')), undefined)
  })

  it('rejects a default export that is not defineBoot(...)', async () => {
    await assert.rejects(discoverBoot(resolve(bootDir, 'not-boot.ts')), /defineBoot/)
  })

  it('returns the definition for a valid boot.ts', async () => {
    const def = await discoverBoot(resolve(bootDir, 'boot-bump.ts'))
    assert.ok(def)
    assert.equal(typeof def?.run, 'function')
  })
})

describe('runBoot', () => {
  it('is a no-op (undefined) when there is no definition', async () => {
    const teardown = await runBoot(undefined, {
      dispatchToApp: async () => ({ committed: false }),
      config: { trustedOrigins: [], sameSite: 'Lax' },
    })
    assert.equal(teardown, undefined)
  })

  it('passes a working BootContext and returns the teardown', async () => {
    const seen: string[] = []
    const def = await discoverBoot(resolve(bootDir, 'boot-bump.ts'))
    const teardown = await runBoot(def, {
      dispatchToApp: async (m: { name: string }, e: { type: string }) => {
        seen.push(`${m.name}:${e.type}`)
        return { committed: true }
      },
      config: { trustedOrigins: [], sameSite: 'Lax' },
    })
    assert.deepStrictEqual(seen, ['BootCounter:BUMP', 'BootCounter:BUMP', 'BootCounter:BUMP'])
    assert.equal(typeof teardown, 'function')
    await teardown?.() // callable without throwing
  })

  it('returns undefined when the boot function returns nothing', async () => {
    const def = await discoverBoot(resolve(bootDir, 'boot-void.ts'))
    const teardown = await runBoot(def, {
      dispatchToApp: async () => ({ committed: false }),
      config: { trustedOrigins: [], sameSite: 'Lax' },
    })
    assert.equal(teardown, undefined)
  })
})

describe('boot end-to-end through a real app', () => {
  it("boot's dispatchToApp lands on the app machine (rendered via a route)", async () => {
    const app = await createApp({
      machinesDir: resolve(bootDir, 'machines'),
      routesDir: resolve(bootDir, 'routes'),
    })
    // Before boot, the counter is 0.
    const before = await (await app.fetch(new Request('http://localhost/count'))).text()
    assert.match(before, /Count: <span>0</)

    // Run boot with the REAL app's dispatchToApp (what listen() wires).
    const def = await discoverBoot(resolve(bootDir, 'boot-bump.ts'))
    await runBoot(def, {
      dispatchToApp: app.dispatchToApp,
      config: { trustedOrigins: [], sameSite: 'Lax' },
    })

    const after = await (await app.fetch(new Request('http://localhost/count'))).text()
    assert.match(after, /Count: <span>3</) // boot's three BUMPs landed
  })
})
