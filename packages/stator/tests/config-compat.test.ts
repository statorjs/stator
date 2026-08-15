import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAppConfig } from '../src/server/config-compat.ts'
import { InMemoryAppStore, InMemoryStore } from '../src/server/index.ts'

describe('resolveAppConfig (createApp/createDevApp flat-key compat)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('accepts the deprecated flat keys, resolves them, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new InMemoryStore()
    const app = new InMemoryAppStore()

    const resolved = resolveAppConfig({
      store: session,
      appStore: app,
      sessionTtlSeconds: 3600,
      ssePingMs: 40,
      inspector: false,
    })

    expect(resolved).toEqual({
      session,
      app,
      sessionTtlSeconds: 3600,
      ssePingMs: 40,
      inspector: false,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = warn.mock.calls[0]?.[0] as string
    expect(msg).toContain('store → persistence.session')
    expect(msg).toContain('appStore → persistence.app')
    expect(msg).toContain('sessionTtlSeconds → sessions.ttlSeconds')
    expect(msg).toContain('ssePingMs → realtime.pingMs')
    expect(msg).toContain('inspector → dev.inspector')
  })

  it('resolves the nested shape with no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new InMemoryStore()
    const app = new InMemoryAppStore()

    const resolved = resolveAppConfig({
      persistence: { session, app },
      sessions: { ttlSeconds: 100 },
      realtime: { pingMs: 10 },
      dev: { inspector: true },
      logging: { level: 'warn' },
    })

    expect(resolved).toEqual({
      session,
      app,
      sessionTtlSeconds: 100,
      ssePingMs: 10,
      inspector: true,
      logLevel: 'warn',
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('prefers the nested value when both flat and nested are present', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const flat = new InMemoryStore()
    const nested = new InMemoryStore()

    const resolved = resolveAppConfig({
      store: flat,
      persistence: { session: nested },
      sessionTtlSeconds: 1,
      sessions: { ttlSeconds: 2 },
    })

    expect(resolved.session).toBe(nested)
    expect(resolved.sessionTtlSeconds).toBe(2)
  })

  it('returns all-undefined and no warning for an empty config', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveAppConfig({})).toEqual({
      session: undefined,
      app: undefined,
      sessionTtlSeconds: undefined,
      ssePingMs: undefined,
      inspector: undefined,
    })
    expect(warn).not.toHaveBeenCalled()
  })
})
