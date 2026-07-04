import { createActor, type EffectInvocation, type Snapshot } from '../engine/index.ts'
import { type AppStore, InMemoryAppStore } from './app-store.ts'
import type { AnyMachineDef, SubscribeEvent } from './define-machine.ts'
import { recordTouch } from './dispatch-context.ts'
import { createInstanceProxy, type InstanceHandle } from './instance-proxy.ts'
import { scopedLogger } from './logger.ts'
import { serverReadsResolver } from './reads-helpers.ts'
import type { Store } from './store.ts'

const storeLog = scopedLogger('machine-store')

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
  private defs = new Map<string, AnyMachineDef>()
  /** Reverse index over `subscribes`: for each emit source, the list of
   *  subscribing machines + which event they care about + what to dispatch.
   *  Computed once at construction so SessionRuntime.wireSubscriptions is
   *  a single Map lookup per session-machine. */
  private subscribersBySource = new Map<
    string,
    Array<{
      targetName: string
      event: string
      dispatch: { type: string; [k: string]: unknown }
    }>
  >()

  /** Default per-session TTL in seconds. Applied on every persistTouched
   *  so a session stays alive as long as the user keeps interacting; idle
   *  sessions expire as a whole. Adapters honor this on `set()`. */
  readonly sessionTtlSeconds: number

  /** Persistence for `persist: true` APP machines (no TTL, one blob per
   *  machine). Defaults to in-memory (restart-wipe) — pass RedisAppStore for
   *  durable app state. */
  readonly appStore: AppStore

  /** Host-injected scheduler for app-machine effects (see server/effects.ts
   *  wireAppEffects). Set after construction to avoid an import cycle;
   *  unwired effects are dropped loudly. */
  private appEffectScheduler: ((invocation: EffectInvocation) => void) | null = null

  constructor(
    defs: AnyMachineDef[],
    readonly persistence: Store,
    opts?: { sessionTtlSeconds?: number; appStore?: AppStore },
  ) {
    this.sessionTtlSeconds = opts?.sessionTtlSeconds ?? 86400
    this.appStore = opts?.appStore ?? new InMemoryAppStore()
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
        const dispatch = typeof sub.dispatch === 'string' ? { type: sub.dispatch } : sub.dispatch
        let list = this.subscribersBySource.get(sub.from.name)
        if (!list) {
          list = []
          this.subscribersBySource.set(sub.from.name, list)
        }
        list.push({ targetName: def.name, event: sub.event, dispatch })
      }
    }
  }

  async bootAppMachines(): Promise<void> {
    for (const def of this.defs.values()) {
      if (def.lifecycle === 'app' && !this.appInstances.has(def.name)) {
        const snapshot = def.persist ? await this.loadAppSnapshot(def.name) : undefined
        const actor = createActor(def, {
          snapshot,
          resolveHelpers: serverReadsResolver(def),
          // App effects run through the host scheduler wired by
          // wireAppEffects (server/effects.ts) — injected post-construction
          // to avoid an import cycle. Unwired: dropped loudly rather than
          // half-run without fan-out or persistence.
          onEffect: (invocation) => {
            if (this.appEffectScheduler) this.appEffectScheduler(invocation)
            else
              storeLog.warn(
                { machine: invocation.machineName, effectId: invocation.effectId },
                'app-machine effect dropped — no scheduler wired (call wireAppEffects(store))',
              )
          },
        }).start()
        this.appInstances.set(def.name, createInstanceProxy(def, actor))
      }
    }
    this.wireAppSubscriptions()
  }

  /** Load + validate a persisted app snapshot. Corrupt or unloadable state
   *  logs loud and boots fresh — restart-fresh is the safe default. */
  private async loadAppSnapshot(name: string): Promise<Snapshot<object> | undefined> {
    try {
      const raw = await this.appStore.loadAppMachine(name)
      if (raw === null) return undefined
      const snap = raw as Snapshot<object>
      if (!Array.isArray(snap.value) || typeof snap.context !== 'object' || snap.context === null) {
        throw new Error('snapshot shape invalid (expected { value: string[], context: object })')
      }
      return snap
    } catch (err) {
      storeLog.error(
        { machine: name, err: String(err) },
        'persisted app-machine snapshot unusable — booting fresh',
      )
      return undefined
    }
  }

  /** Install the app-effect scheduler (see server/effects.ts wireAppEffects). */
  setAppEffectScheduler(scheduler: (invocation: EffectInvocation) => void): void {
    this.appEffectScheduler = scheduler
  }

  /** Persist one app machine's snapshot, if it opted in. Safe no-op for
   *  session machines, non-persist app machines, and unknown names — callers
   *  pass raw touched-set entries. */
  async persistAppMachine(name: string): Promise<void> {
    const def = this.defs.get(name)
    if (def?.lifecycle !== 'app' || !def.persist) return
    const handle = this.appInstances.get(name)
    if (!handle) return
    await this.appStore.saveAppMachine(name, handle.actor.getPersistedSnapshot())
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
        sourceHandle.actor.on(sub.event as never, (emitted) => {
          targetHandle.actor.send(buildDispatchEvent(emitted, sub.dispatch) as never)
          recordTouch(targetName)
        })
      }
    }
  }

  appInstance(name: string): InstanceHandle | undefined {
    return this.appInstances.get(name)
  }

  getDef(name: string): AnyMachineDef | undefined {
    return this.defs.get(name)
  }

  allDefs(): AnyMachineDef[] {
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
