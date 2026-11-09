import type { LogLevel } from '../config.ts'
import type { AppStore } from './app-store.ts'
import type { Store } from './store.ts'

/**
 * Flat `createApp`/`createDevApp` keys that are no longer accepted, and where
 * each moved. A caller that passes one gets an error naming the new home
 * instead of a silently ignored option.
 */
const REMOVED_KEYS: Record<string, string> = {
  store: 'persistence.session',
  appStore: 'persistence.app',
  sessionTtlSeconds: 'sessions.ttlSeconds',
  ssePingMs: 'realtime.pingMs',
  inspector: 'dev.inspector',
}

export interface NestedReads {
  persistence?: { session?: Store; app?: AppStore }
  sessions?: { ttlSeconds?: number; cookie?: { sameSite?: 'Lax' | 'Strict' } }
  realtime?: { pingMs?: number }
  dev?: { inspector?: boolean }
  logging?: { level?: LogLevel }
  trustedOrigins?: readonly string[]
  origin?: string
  host?: string
  secret?: string
  cors?: { origins?: readonly string[]; credentials?: boolean }
  caching?: { sMaxAge?: number; staleWhileRevalidate?: number } | false
}

/** The flat internal values `createApp`/`createDevApp` actually consume. */
export interface ResolvedAppConfig {
  session?: Store
  app?: AppStore
  sessionTtlSeconds?: number
  ssePingMs?: number
  inspector?: boolean
  logLevel?: LogLevel
  trustedOrigins?: readonly string[]
  sameSite?: 'Lax' | 'Strict'
  origin?: string
  host?: string
  /** Signed-cookie signing key. `config.secret` ?? `STATOR_SECRET`. */
  secret?: string
  cors?: { origins: readonly string[]; credentials: boolean }
  /** Derived Cache-Control knobs; `false` disables emission entirely. */
  caching?: { sMaxAge?: number; staleWhileRevalidate?: number } | false
}

/**
 * Resolve the nested config into the flat values `createApp`/`createDevApp`
 * consume. Throws on a removed flat key, naming where it moved.
 */
export function resolveAppConfig(config: NestedReads): ResolvedAppConfig {
  const removed = Object.keys(REMOVED_KEYS).filter(
    (k) => (config as Record<string, unknown>)[k] !== undefined,
  )
  if (removed.length > 0) {
    throw new Error(
      'stator: these createApp/createDevApp options were removed in 3.0 — use the nested shape:\n' +
        removed.map((k) => `  ${k} → ${REMOVED_KEYS[k]}`).join('\n'),
    )
  }

  return {
    session: config.persistence?.session,
    app: config.persistence?.app,
    sessionTtlSeconds: config.sessions?.ttlSeconds,
    ssePingMs: config.realtime?.pingMs,
    inspector: config.dev?.inspector,
    logLevel: config.logging?.level,
    trustedOrigins: config.trustedOrigins,
    sameSite: config.sessions?.cookie?.sameSite,
    origin: config.origin,
    host: config.host,
    // The signing key: explicit config wins, else the env (loadable via .env).
    secret: config.secret ?? process.env.STATOR_SECRET,
    cors: config.cors
      ? {
          origins: config.cors.origins ?? config.trustedOrigins ?? [],
          credentials: config.cors.credentials ?? false,
        }
      : undefined,
    caching: config.caching,
  }
}
