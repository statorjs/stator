import type { AppStore } from './app-store.ts'
import { InMemoryAppStore } from './app-store.ts'
import { CachedStore, type CachedStoreOptions } from './cached-store.ts'
import { RedisAppStore, RedisStore } from './redis-store.ts'
import { InMemoryStore, type Store } from './store.ts'

/**
 * Picking a store from the environment, without the silent downgrade.
 *
 * Every app that keeps state in Redis writes the same conditional: a URL from
 * the environment, a durable store when it's there, in-memory when it isn't.
 * That fallback is right for dev and for CI — a build machine has no business
 * holding production credentials — and wrong in exactly one place, production,
 * where it means the app runs, looks healthy, and quietly loses every session
 * on restart. Written in userland the framework cannot tell that outcome from a
 * deliberate choice, so it cannot say anything about it.
 *
 * Moving the conditional in here changes only that: the returned store carries
 * whether in-memory was *chosen* or *fallen back to*, so startup can be silent
 * in development and loud in production, naming the empty variable instead of
 * reporting a generic posture.
 *
 * The environment stays in charge. A URL present means durable, wherever it
 * comes from — so pointing CI at a test Redis is nothing special, it is just
 * the variable being set. An empty or whitespace-only value counts as absent,
 * which is what a CI system that defines every variable as `""` produces.
 */

/** Recorded on a fallback store so startup can tell it from a deliberate one.
 *  Non-enumerable and internal: the value still satisfies `Store` exactly. */
const INTENT = Symbol.for('stator.store.intent')

interface StoreIntent {
  /** What the app asked for. */
  wanted: 'durable'
  /** The config field that was empty, for the message. */
  from: string
}

function mark<T extends object>(store: T, intent: StoreIntent): T {
  Object.defineProperty(store, INTENT, { value: intent, enumerable: false })
  return store
}

/** The recorded intent of a store, if it was built by these helpers. */
export function storeIntent(store: unknown): StoreIntent | undefined {
  if (store === null || typeof store !== 'object') return undefined
  return (store as Record<symbol, StoreIntent | undefined>)[INTENT]
}

/** True for the framework's own in-memory adapters — the ones that do not
 *  survive a restart. A store the app supplied is assumed durable; the
 *  framework has no way to ask, and no business guessing. */
export function isEphemeral(store: unknown): boolean {
  return store instanceof InMemoryStore || store instanceof InMemoryAppStore
}

const blank = (url: string | undefined): boolean => url === undefined || url.trim() === ''

export interface StoreFromEnvOptions {
  /** Redis connection string, typically `process.env.REDIS_URL`. Absent, empty
   *  or whitespace-only selects in-memory — normal in dev and CI, reported at
   *  startup in production. */
  redisUrl?: string
  /** Wrap Redis in a write-through memory cache. Off by default: caching is a
   *  performance decision, and this helper's job is the durable-or-not one. */
  cache?: CachedStoreOptions | true
  /** Key prefix, passed through to the Redis adapter. */
  keyPrefix?: string
  /** Name used in the startup report when the URL is empty. Default `REDIS_URL`. */
  envName?: string
}

/**
 * Session-machine storage from the environment: Redis when a URL is set,
 * in-memory otherwise.
 *
 *   persistence: { session: sessionStore({ redisUrl: process.env.REDIS_URL }) }
 *
 * Call it with nothing (or omit `persistence.session` entirely) to choose
 * in-memory deliberately — that is a real choice and is never reported.
 */
export function sessionStore(opts: StoreFromEnvOptions = {}): Store {
  if (blank(opts.redisUrl)) {
    // In-memory either way, but for two different reasons. Passing the key at
    // all — `redisUrl: process.env.REDIS_URL` — says the app wants durability
    // from the environment, so an empty value is worth reporting in production.
    // Passing no key says in-memory was the choice, which is never reported.
    return 'redisUrl' in opts
      ? mark(new InMemoryStore(), { wanted: 'durable', from: opts.envName ?? 'REDIS_URL' })
      : new InMemoryStore()
  }
  const redis = opts.keyPrefix
    ? new RedisStore(opts.redisUrl as string, opts.keyPrefix)
    : new RedisStore(opts.redisUrl as string)
  if (!opts.cache) return redis
  return new CachedStore(redis, opts.cache === true ? {} : opts.cache)
}

/**
 * App-machine storage (`persist: true`) from the environment. Same rule as
 * `sessionStore`.
 */
export function appStore(opts: StoreFromEnvOptions = {}): AppStore {
  if (blank(opts.redisUrl)) {
    return 'redisUrl' in opts
      ? mark(new InMemoryAppStore(), { wanted: 'durable', from: opts.envName ?? 'REDIS_URL' })
      : new InMemoryAppStore()
  }
  return opts.keyPrefix
    ? new RedisAppStore(opts.redisUrl as string, opts.keyPrefix)
    : new RedisAppStore(opts.redisUrl as string)
}

/** One machine's persistence-relevant shape. */
export interface MachinePersistence {
  lifecycle: string
  persist: boolean
}

/**
 * What to say about persistence at startup. The posture goes in the notice —
 * printed at every level, so a deploy log always states whether state survives
 * a restart — and anything worth alerting on comes back as a warning.
 *
 * Warnings fire in production only, and only when something is actually at
 * risk: an app with no session machines has no session state to lose, and an
 * app that deliberately chose in-memory made a real choice. Nothing here ever
 * refuses to start; persistent storage is assumed to be wanted, never required.
 */
export function persistencePosture(input: {
  session: unknown
  app: unknown
  machines: readonly MachinePersistence[]
  production: boolean
}): { label: string; warnings: string[] } {
  const name = (store: unknown): string =>
    isEphemeral(store)
      ? 'in-memory'
      : ((store as { constructor?: { name?: string } })?.constructor?.name ?? 'custom')

  const sessionMachines = input.machines.filter((m) => m.lifecycle === 'session').length
  const persistedApp = input.machines.filter((m) => m.lifecycle === 'app' && m.persist).length

  let label = `sessions ${name(input.session)}`
  if (persistedApp > 0) label += ` · app ${name(input.app)}`

  const warnings: string[] = []
  if (input.production) {
    const sessionIntent = storeIntent(input.session)
    if (isEphemeral(input.session) && sessionIntent) {
      // The app configured a durable store and the variable was empty — the
      // one case the framework can name precisely.
      warnings.push(
        `${sessionIntent.from} is empty, so session state is in memory and will not survive a restart`,
      )
    } else if (isEphemeral(input.session) && sessionMachines > 0) {
      warnings.push(
        `no durable session store is configured, so the state of ${sessionMachines} session machine${
          sessionMachines === 1 ? '' : 's'
        } will not survive a restart`,
      )
    }

    const appIntent = storeIntent(input.app)
    if (isEphemeral(input.app) && persistedApp > 0) {
      warnings.push(
        appIntent
          ? `${appIntent.from} is empty, so ${persistedApp} persisted app machine${persistedApp === 1 ? '' : 's'} will not survive a restart`
          : `no durable app store is configured, so ${persistedApp} persisted app machine${persistedApp === 1 ? '' : 's'} will not survive a restart`,
      )
    }
  }
  return { label, warnings }
}
