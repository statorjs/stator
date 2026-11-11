import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
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
    assert.ok(store instanceof InMemoryStore)
    assert.equal(storeIntent(store)?.wanted, 'durable')
    assert.equal(storeIntent(store)?.from, 'REDIS_URL')
  })

  it('treats an empty or whitespace-only URL as absent', () => {
    // What a CI system that defines every variable as "" produces.
    for (const redisUrl of ['', '   ', '\n']) {
      assert.ok(sessionStore({ redisUrl }) instanceof InMemoryStore)
    }
  })

  it('records no intent when in-memory was chosen deliberately', () => {
    // Called with nothing: a real choice, and never reported.
    assert.equal(storeIntent(sessionStore()), undefined)
    assert.equal(storeIntent(new InMemoryStore()), undefined)
  })

  it('names the variable it was given, for the message', () => {
    const store = sessionStore({ redisUrl: undefined, envName: 'SESSION_REDIS_URL' })
    assert.equal(storeIntent(store)?.from, 'SESSION_REDIS_URL')
  })

  it('distinguishes an empty value from an absent key', () => {
    // `redisUrl: process.env.REDIS_URL` with the variable unset means the app
    // wanted durability and did not get it. `sessionStore()` means it chose
    // in-memory. Both produce an InMemoryStore; only the first is reported.
    assert.notEqual(storeIntent(sessionStore({ redisUrl: process.env.NOPE_UNSET })), undefined)
    assert.equal(storeIntent(sessionStore({})), undefined)
    assert.notEqual(storeIntent(appStore({ redisUrl: undefined })), undefined)
    assert.equal(storeIntent(appStore()), undefined)
  })

  it('classifies the framework in-memory adapters as ephemeral, and nothing else', () => {
    assert.equal(isEphemeral(new InMemoryStore()), true)
    assert.equal(isEphemeral(new InMemoryAppStore()), true)
    // A store the app supplied is assumed durable — the framework cannot ask.
    assert.equal(isEphemeral({ load: () => {}, save: () => {} }), false)
  })
})

describe('sessionStore: with a URL set', { skip: !REDIS_URL }, () => {
  const built: Array<{ close?: () => Promise<void> }> = []
  after(async () => {
    // Each holds a Redis connection, the cached one through what it wraps.
    for (const store of built) await store.close?.()
  })

  it('builds a Redis store, uncached by default', () => {
    const store = sessionStore({ redisUrl: REDIS_URL }) as RedisStore
    built.push(store)
    assert.equal(store.constructor.name, 'RedisStore')
    assert.equal(isEphemeral(store), false)
    assert.equal(storeIntent(store), undefined) // nothing fell back
  })

  it('wraps in a write-through cache when asked', () => {
    const store = sessionStore({ redisUrl: REDIS_URL, cache: true })
    assert.ok(store instanceof CachedStore)
    built.push(store as unknown as { close?: () => Promise<void> })
  })

  it('does the same for the app store', () => {
    const store = appStore({ redisUrl: REDIS_URL }) as RedisAppStore
    built.push(store)
    assert.equal(store.constructor.name, 'RedisAppStore')
  })
})

describe('persistence posture: what startup reports', () => {
  const durable = { load: () => {}, save: () => {} }

  it('always states the posture, in every environment', () => {
    assert.equal(
      persistencePosture({
        session: new InMemoryStore(),
        app: new InMemoryAppStore(),
        machines: machines([['session']]),
        production: false,
      }).label,
      'sessions in-memory',
    )

    assert.match(
      persistencePosture({
        session: durable,
        app: new InMemoryAppStore(),
        machines: machines([['session']]),
        production: true,
      }).label,
      /^sessions /,
    )
  })

  it('says nothing outside production, however state is stored', () => {
    // Absent Redis in dev and CI is the common, correct case.
    const { warnings } = persistencePosture({
      session: sessionStore({ redisUrl: undefined }),
      app: new InMemoryAppStore(),
      machines: machines([['session'], ['session']]),
      production: false,
    })
    assert.deepStrictEqual(warnings, [])
  })

  it('names the empty variable when the app configured a durable store', () => {
    const { warnings } = persistencePosture({
      session: sessionStore({ redisUrl: '' }),
      app: new InMemoryAppStore(),
      machines: machines([['session']]),
      production: true,
    })
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0])
    assert.ok(warnings[0]!.includes('REDIS_URL is empty'))
  })

  it('falls back to a general warning when nothing was configured', () => {
    const { warnings } = persistencePosture({
      session: new InMemoryStore(),
      app: new InMemoryAppStore(),
      machines: machines([['session'], ['session']]),
      production: true,
    })
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0])
    assert.ok(warnings[0]!.includes('no durable session store'))
    assert.ok(warnings[0])
    assert.ok(warnings[0]!.includes('2 session machines'))
  })

  it('stays quiet when there is no session state to lose', () => {
    // An app of app-lifecycle machines only has nothing at risk here.
    const { warnings } = persistencePosture({
      session: new InMemoryStore(),
      app: new InMemoryAppStore(),
      machines: machines([['app'], ['app']]),
      production: true,
    })
    assert.deepStrictEqual(warnings, [])
  })

  it('reports persisted app machines on ephemeral app storage', () => {
    const posture = persistencePosture({
      session: durable,
      app: new InMemoryAppStore(),
      machines: machines([['app', true], ['app', true], ['app']]),
      production: true,
    })
    assert.ok(posture.label.includes('app in-memory'))
    assert.equal(posture.warnings.length, 1)
    assert.ok(posture.warnings[0])
    assert.ok(posture.warnings[0]!.includes('2 persisted app machines'))
  })

  it('is silent when everything is durable', () => {
    const posture = persistencePosture({
      session: durable,
      app: durable,
      machines: machines([['session'], ['app', true]]),
      production: true,
    })
    assert.deepStrictEqual(posture.warnings, [])
  })
})
