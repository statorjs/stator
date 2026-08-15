import type { AppStore } from './app-store.ts'
import type { Store } from './store.ts'

/**
 * The pre-nesting flat config keys. `createApp` shipped all of these at 2.1.0 (and
 * `createDevApp` all but `ssePingMs`), so they stay ACCEPTED — typed and
 * `@deprecated`, not removed — to keep those callers compiling and running:
 * nesting the args would otherwise be a breaking change (a major). The removal is
 * parked as a major-cutover (see ROADMAP surface hygiene). Nested values win when
 * both a flat key and its nested home are present.
 */
export interface DeprecatedFlatConfig {
  /** @deprecated use `persistence.session` */
  store?: Store
  /** @deprecated use `persistence.app` */
  appStore?: AppStore
  /** @deprecated use `sessions.ttlSeconds` */
  sessionTtlSeconds?: number
  /** @deprecated use `realtime.pingMs` */
  ssePingMs?: number
  /** @deprecated use `dev.inspector` */
  inspector?: boolean
}

interface NestedReads {
  persistence?: { session?: Store; app?: AppStore }
  sessions?: { ttlSeconds?: number }
  realtime?: { pingMs?: number }
  dev?: { inspector?: boolean }
}

/** The flat internal values `createApp`/`createDevApp` actually consume. */
export interface ResolvedAppConfig {
  session?: Store
  app?: AppStore
  sessionTtlSeconds?: number
  ssePingMs?: number
  inspector?: boolean
}

/**
 * Resolve the nested config, falling back to the deprecated flat keys, and warn
 * once (per app construction) if any flat key is in use. Nested wins. Exported for
 * testing.
 */
export function resolveAppConfig(config: NestedReads & DeprecatedFlatConfig): ResolvedAppConfig {
  const deprecated: string[] = []
  if (config.store !== undefined) deprecated.push('store → persistence.session')
  if (config.appStore !== undefined) deprecated.push('appStore → persistence.app')
  if (config.sessionTtlSeconds !== undefined)
    deprecated.push('sessionTtlSeconds → sessions.ttlSeconds')
  if (config.ssePingMs !== undefined) deprecated.push('ssePingMs → realtime.pingMs')
  if (config.inspector !== undefined) deprecated.push('inspector → dev.inspector')

  if (deprecated.length > 0) {
    console.warn(
      'stator: these createApp/createDevApp options are deprecated and will be removed in a future major — move to the nested shape:\n' +
        deprecated.map((d) => `  ${d}`).join('\n'),
    )
  }

  return {
    session: config.persistence?.session ?? config.store,
    app: config.persistence?.app ?? config.appStore,
    sessionTtlSeconds: config.sessions?.ttlSeconds ?? config.sessionTtlSeconds,
    ssePingMs: config.realtime?.pingMs ?? config.ssePingMs,
    inspector: config.dev?.inspector ?? config.inspector,
  }
}
