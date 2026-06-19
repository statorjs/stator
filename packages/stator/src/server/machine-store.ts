import { createActor } from '../engine/index.ts'
import type { MachineDef, SubscribeEvent } from './define-machine.ts'
import { createInstanceProxy, type InstanceHandle } from './instance-proxy.ts'
import { recordTouch } from './dispatch-context.ts'
import { serverReadsResolver } from './reads-helpers.ts'
import type { Store } from './store.ts'

/**
 * Compose the event a subscriber actually receives. Order of precedence:
 *   1. Payload from the source's emit selector (fields like `productId`, `items`).
 *   2. Subscriber's `dispatch` declaration (`type` and any static fields it adds).
 *   3. `sourceSessionId` when injected — set by the caller for cross-lifecycle
 *      subscriptions only.
 * Subscriber-side fields override source payload fields on collision; the
 * subscriber owns the shape of its own inbox.
 */
export function buildDispatchEvent(
  emitted: { type?: string; [k: string]: unknown } | undefined,
  dispatch: SubscribeEvent,
  sourceSessionId?: string,
): { type: string; [k: string]: unknown } {
  const { type: _emitType, ...payload } = emitted ?? {}
  const dispatchBase = typeof dispatch === 'string' ? { type: dispatch } : dispatch
  return {
    ...payload,
    ...dispatchBase,
    ...(sourceSessionId !== undefined ? { sourceSessionId } : {}),
  }
}

/**
 * Machine registry + long-lived app-machine actors + persistence adapter.
 *
 * Session-lifecycle machine actors are *not* held here anymore — they are
 * created transiently inside a SessionRuntime per request, hydrated from
 * the Store, and dropped when the request completes. This keeps server
 * memory bounded by (open SSE connections + active in-flight requests)
 * rather than (every session ever seen).
 */
export class MachineStore {
  private appInstances = new Map<string, InstanceHandle>()
  private defs = new Map<string, MachineDef<any, any>>()
  /** Reverse index over `subscribes`: for each emit source, the list of
   *  subscribing machines + which event they care about + what to dispatch.
   *  Computed once at construction so SessionRuntime.wireSubscriptions is
   *  a single Map lookup per session-machine. */
  private subscribersBySource = new Map<
    string,
    Array<{ targetName: string; event: string; dispatch: { type: string; [k: string]: unknown } }>
  >()

  /** Default per-session TTL in seconds. Applied on every persistTouched
   *  so a session stays alive as long as the user keeps interacting; idle
   *  sessions expire as a whole. Adapters honor this on `set()`. */
  readonly sessionTtlSeconds: number

  constructor(
    defs: MachineDef<any, any>[],
    readonly persistence: Store,
    opts?: { sessionTtlSeconds?: number },
  ) {
    this.sessionTtlSeconds = opts?.sessionTtlSeconds ?? 86400
    for (const def of defs) {
      if (this.defs.has(def.name)) {
        throw new Error(`stator: duplicate machine name "${def.name}"`)
      }
      this.defs.set(def.name, def)
    }
    this.validateSubscriptions()
    this.buildSubscriberIndex()
  }

  private validateSubscriptions(): void {
    for (const def of this.defs.values()) {
      for (const sub of def.subscribes) {
        if (!this.defs.has(sub.from.name)) {
          throw new Error(
            `stator: machine "${def.name}" subscribes to unknown machine "${sub.from.name}"`,
          )
        }
        if (sub.from.lifecycle === 'app' && def.lifecycle === 'session') {
          throw new Error(
            `stator: app-lifecycle source "${sub.from.name}" cannot deliver to ` +
              `session-lifecycle target "${def.name}" yet — app→session needs the ` +
              `inbox model (see docs/design-notes/app-to-session-subscriptions.md). ` +
              `Use session→app or same-lifecycle subscriptions for now.`,
          )
        }
        const emitNames = Object.keys(sub.from.emits)
        if (emitNames.length > 0 && !(sub.event in sub.from.emits)) {
          throw new Error(
            `stator: machine "${def.name}" subscribes to "${sub.from.name}.${sub.event}", ` +
              `but "${sub.from.name}" does not declare "${sub.event}" in its emits.`,
          )
        }
      }
    }
  }

  private buildSubscriberIndex(): void {
    for (const def of this.defs.values()) {
      for (const sub of def.subscribes) {
        const dispatch =
          typeof sub.dispatch === 'string' ? { type: sub.dispatch } : sub.dispatch
        let list = this.subscribersBySource.get(sub.from.name)
        if (!list) {
          list = []
          this.subscribersBySource.set(sub.from.name, list)
        }
        list.push({ targetName: def.name, event: sub.event, dispatch })
      }
    }
  }

  bootAppMachines(): void {
    for (const def of this.defs.values()) {
      if (def.lifecycle === 'app' && !this.appInstances.has(def.name)) {
        const actor = createActor(def, { resolveHelpers: serverReadsResolver(def) }).start()
        this.appInstances.set(def.name, createInstanceProxy(def, actor))
      }
    }
    this.wireAppSubscriptions()
  }

  /** Wire app→app subscription listeners. Session-involved subscriptions
   *  (session→session, session→app) are wired per-request inside
   *  SessionRuntime. Same-lifecycle so no sourceSessionId injection. */
  private wireAppSubscriptions(): void {
    for (const targetHandle of this.appInstances.values()) {
      const targetName = targetHandle.def.name
      for (const sub of targetHandle.def.subscribes) {
        const sourceHandle = this.appInstances.get(sub.from.name)
        if (!sourceHandle) continue
        sourceHandle.actor.on(sub.event as never, (emitted: any) => {
          targetHandle.actor.send(buildDispatchEvent(emitted, sub.dispatch) as never)
          recordTouch(targetName)
        })
      }
    }
  }

  appInstance(name: string): InstanceHandle | undefined {
    return this.appInstances.get(name)
  }

  getDef(name: string): MachineDef<any, any> | undefined {
    return this.defs.get(name)
  }

  allDefs(): MachineDef<any, any>[] {
    return [...this.defs.values()]
  }

  /** Subscribers (target machine + dispatch info) for a given source machine. */
  subscribersOf(sourceName: string): ReadonlyArray<{
    targetName: string
    event: string
    dispatch: { type: string; [k: string]: unknown }
  }> {
    return this.subscribersBySource.get(sourceName) ?? []
  }

  hasMachine(name: string): boolean {
    return this.defs.has(name)
  }

  async disposeSession(sessionId: string): Promise<void> {
    await this.persistence.deleteSession(sessionId)
  }
}
