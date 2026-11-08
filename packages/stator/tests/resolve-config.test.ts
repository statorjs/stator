import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemoryAppStore } from '../src/server/app-store.ts'
import { resolveAppConfig } from '../src/server/resolve-config.ts'
import { InMemoryStore } from '../src/server/store.ts'

describe('resolveAppConfig', () => {
  it('resolves the nested shape into the values the runtime consumes', () => {
    const session = new InMemoryStore()
    const app = new InMemoryAppStore()
    const resolved = resolveAppConfig({
      persistence: { session, app },
      sessions: { ttlSeconds: 60, cookie: { sameSite: 'Strict' } },
      realtime: { pingMs: 5000 },
      dev: { inspector: false },
      logging: { level: 'debug' },
    })
    assert.equal(resolved.session, session)
    assert.equal(resolved.app, app)
    assert.equal(resolved.sessionTtlSeconds, 60)
    assert.equal(resolved.sameSite, 'Strict')
    assert.equal(resolved.ssePingMs, 5000)
    assert.equal(resolved.inspector, false)
    assert.equal(resolved.logLevel, 'debug')
  })

  it('leaves every option unset for an empty config', () => {
    const resolved = resolveAppConfig({})
    assert.equal(resolved.session, undefined)
    assert.equal(resolved.sessionTtlSeconds, undefined)
    assert.equal(resolved.inspector, undefined)
  })

  it('refuses the flat keys removed in 3.0, naming where each moved', () => {
    assert.throws(
      () => resolveAppConfig({ store: new InMemoryStore(), inspector: true } as never),
      (err: Error) =>
        /removed in 3\.0/.test(err.message) &&
        err.message.includes('store → persistence.session') &&
        err.message.includes('inspector → dev.inspector'),
    )
  })
})
