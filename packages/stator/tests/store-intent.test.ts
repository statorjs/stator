import { afterAll, describe, expect, it } from 'vitest'
import { InMemoryAppStore } from '../src/server/app-store.ts'
import { CachedStore } from '../src/server/cached-store.ts'
import type { RedisAppStore, RedisStore } from '../src/server/redis-store.ts'
import { InMemoryStore } from '../src/server/store.ts'
import {
  appStore,
  isEphemeral,
  persistencePosture,
  sessionStore,
  storeIntent,
} from '../src/server/store-intent.ts'

/**
 * Choosing a store from the environment, and what startup says about it.
 *
 * The rule: a URL present means durable, wherever it comes from — so pointing
 * CI at a test Redis is just the variable being set, never a special case — and
 * absent means in-memory, which is correct in dev and CI and reported only in
 * production. Nothing here ever refuses to start.
 */

const REDIS_URL = process.env.REDIS_URL

const machines = (spec: Array<[lifecycle: string, persist?: boolean]>) =>
  spec.map(([lifecycle, persist]) => ({ lifecycle, persist: persist ?? false }))

describe('sessionStore: choosing from the environment', () => {
  it('falls back to in-memory when the URL is absent, and remembers that it did', () => {
    const store = sessionStore({ redisUrl: undefined })
    expect(store).toBeInstanceOf(InMemoryStore)
    expect(storeIntent(store)?.wanted).toBe('durable')
    expect(storeIntent(store)?.from).toBe('REDIS_URL')
  })

  it('treats an empty or whitespace-only URL as absent', () => {
    // What a CI system that defines every variable as "" produces.
    for (const redisUrl of ['', '   ', '\n']) {
      expect(sessionStore({ redisUrl })).toBeInstanceOf(InMemoryStore)
    }
  })

  it('records no intent when in-memory was chosen deliberately', () => {
    // Called with nothing: a real choice, and never reported.
    expect(storeIntent(sessionStore())).toBeUndefined()
    expect(storeIntent(new InMemoryStore())).toBeUndefined()
  })

  it('names the variable it was given, for the message', () => {
    const store = sessionStore({ redisUrl: undefined, envName: 'SESSION_REDIS_URL' })
    expect(storeIntent(store)?.from).toBe('SESSION_REDIS_URL')
  })

  it('distinguishes an empty value from an absent key', () => {
    // `redisUrl: process.env.REDIS_URL` with the variable unset means the app
    // wanted durability and did not get it. `sessionStore()` means it chose
    // in-memory. Both produce an InMemoryStore; only the first is reported.
    expect(storeIntent(sessionStore({ redisUrl: process.env.NOPE_UNSET }))).toBeDefined()
    expect(storeIntent(sessionStore({}))).toBeUndefined()
    expect(storeIntent(appStore({ redisUrl: undefined }))).toBeDefined()
    expect(storeIntent(appStore())).toBeUndefined()
  })

  it('classifies the framework in-memory adapters as ephemeral, and nothing else', () => {
    expect(isEphemeral(new InMemoryStore())).toBe(true)
    expect(isEphemeral(new InMemoryAppStore())).toBe(true)
    // A store the app supplied is assumed durable — the framework cannot ask.
    expect(isEphemeral({ load: () => {}, save: () => {} })).toBe(false)
  })
})

describe.skipIf(!REDIS_URL)('sessionStore: with a URL set', () => {
  const built: Array<{ close?: () => Promise<void> }> = []
  afterAll(async () => {
    // CachedStore has no connection of its own; only the Redis adapters do.
    for (const store of built) await store.close?.()
  })

  it('builds a Redis store, uncached by default', () => {
    const store = sessionStore({ redisUrl: REDIS_URL }) as RedisStore
    built.push(store)
    expect(store.constructor.name).toBe('RedisStore')
    expect(isEphemeral(store)).toBe(false)
    expect(storeIntent(store)).toBeUndefined() // nothing fell back
  })

  it('wraps in a write-through cache when asked', () => {
    const store = sessionStore({ redisUrl: REDIS_URL, cache: true })
    expect(store).toBeInstanceOf(CachedStore)
    built.push(store as unknown as { close?: () => Promise<void> })
  })

  it('does the same for the app store', () => {
    const store = appStore({ redisUrl: REDIS_URL }) as RedisAppStore
    built.push(store)
    expect(store.constructor.name).toBe('RedisAppStore')
  })
})

describe('persistence posture: what startup reports', () => {
  const durable = { load: () => {}, save: () => {} }

  it('always states the posture, in every environment', () => {
    expect(
      persistencePosture({
        session: new InMemoryStore(),
        app: new InMemoryAppStore(),
        machines: machines([['session']]),
        production: false,
      }).label,
    ).toBe('sessions in-memory')

    expect(
      persistencePosture({
        session: durable,
        app: new InMemoryAppStore(),
        machines: machines([['session']]),
        production: true,
      }).label,
    ).toMatch(/^sessions /)
  })

  it('says nothing outside production, however state is stored', () => {
    // Absent Redis in dev and CI is the common, correct case.
    const { warnings } = persistencePosture({
      session: sessionStore({ redisUrl: undefined }),
      app: new InMemoryAppStore(),
      machines: machines([['session'], ['session']]),
      production: false,
    })
    expect(warnings).toEqual([])
  })

  it('names the empty variable when the app configured a durable store', () => {
    const { warnings } = persistencePosture({
      session: sessionStore({ redisUrl: '' }),
      app: new InMemoryAppStore(),
      machines: machines([['session']]),
      production: true,
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('REDIS_URL is empty')
  })

  it('falls back to a general warning when nothing was configured', () => {
    const { warnings } = persistencePosture({
      session: new InMemoryStore(),
      app: new InMemoryAppStore(),
      machines: machines([['session'], ['session']]),
      production: true,
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no durable session store')
    expect(warnings[0]).toContain('2 session machines')
  })

  it('stays quiet when there is no session state to lose', () => {
    // An app of app-lifecycle machines only has nothing at risk here.
    const { warnings } = persistencePosture({
      session: new InMemoryStore(),
      app: new InMemoryAppStore(),
      machines: machines([['app'], ['app']]),
      production: true,
    })
    expect(warnings).toEqual([])
  })

  it('reports persisted app machines on ephemeral app storage', () => {
    const posture = persistencePosture({
      session: durable,
      app: new InMemoryAppStore(),
      machines: machines([['app', true], ['app', true], ['app']]),
      production: true,
    })
    expect(posture.label).toContain('app in-memory')
    expect(posture.warnings).toHaveLength(1)
    expect(posture.warnings[0]).toContain('2 persisted app machines')
  })

  it('is silent when everything is durable', () => {
    const posture = persistencePosture({
      session: durable,
      app: durable,
      machines: machines([['session'], ['app', true]]),
      production: true,
    })
    expect(posture.warnings).toEqual([])
  })
})
