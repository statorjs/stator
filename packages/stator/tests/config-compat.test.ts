import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { resolveAppConfig } from '../src/server/config-compat.ts'
import { InMemoryAppStore, InMemoryStore } from '../src/server/index.ts'

/** vitest's toEqual ignored keys whose value is undefined; resolveAppConfig
 *  returns every key, so compare the ones that are set. */
const defined = (o: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

describe('resolveAppConfig (createApp/createDevApp flat-key compat)', () => {
  afterEach(() => mock.restoreAll())

  it('accepts the deprecated flat keys, resolves them, and warns once', () => {
    const warn = mock.method(console, 'warn', () => {})
    const session = new InMemoryStore()
    const app = new InMemoryAppStore()

    const resolved = resolveAppConfig({
      store: session,
      appStore: app,
      sessionTtlSeconds: 3600,
      ssePingMs: 40,
      inspector: false,
    })

    assert.deepStrictEqual(defined(resolved), {
      session,
      app,
      sessionTtlSeconds: 3600,
      ssePingMs: 40,
      inspector: false,
    })
    assert.equal(warn.mock.callCount(), 1)
    const msg = warn.mock.calls[0]?.arguments[0] as string
    assert.ok(msg.includes('store → persistence.session'))
    assert.ok(msg.includes('appStore → persistence.app'))
    assert.ok(msg.includes('sessionTtlSeconds → sessions.ttlSeconds'))
    assert.ok(msg.includes('ssePingMs → realtime.pingMs'))
    assert.ok(msg.includes('inspector → dev.inspector'))
  })

  it('resolves the nested shape with no warning', () => {
    const warn = mock.method(console, 'warn', () => {})
    const session = new InMemoryStore()
    const app = new InMemoryAppStore()

    const resolved = resolveAppConfig({
      persistence: { session, app },
      sessions: { ttlSeconds: 100 },
      realtime: { pingMs: 10 },
      dev: { inspector: true },
      logging: { level: 'warn' },
    })

    assert.deepStrictEqual(defined(resolved), {
      session,
      app,
      sessionTtlSeconds: 100,
      ssePingMs: 10,
      inspector: true,
      logLevel: 'warn',
    })
    assert.equal(warn.mock.callCount(), 0)
  })

  it('prefers the nested value when both flat and nested are present', () => {
    mock.method(console, 'warn', () => {})
    const flat = new InMemoryStore()
    const nested = new InMemoryStore()

    const resolved = resolveAppConfig({
      store: flat,
      persistence: { session: nested },
      sessionTtlSeconds: 1,
      sessions: { ttlSeconds: 2 },
    })

    assert.equal(resolved.session, nested)
    assert.equal(resolved.sessionTtlSeconds, 2)
  })

  it('returns all-undefined and no warning for an empty config', () => {
    const warn = mock.method(console, 'warn', () => {})
    assert.deepStrictEqual(defined(resolveAppConfig({})), {})
    assert.equal(warn.mock.callCount(), 0)
  })
})
