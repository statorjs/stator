import { createActor } from 'xstate'
import type { MachineDef } from './define-machine.ts'
import { createInstanceProxy, type InstanceHandle } from './instance-proxy.ts'
import type { Store } from './store.ts'

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

  constructor(
    defs: MachineDef<any, any>[],
    readonly persistence: Store,
  ) {
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
        if (sub.from.lifecycle !== def.lifecycle) {
          throw new Error(
            `stator: machine "${def.name}" (${def.lifecycle}) subscribes to ` +
              `"${sub.from.name}" (${sub.from.lifecycle}); subscriptions must be ` +
              `between machines of the same lifecycle in the POC.`,
          )
        }
        if (sub.from.emits.length > 0 && !sub.from.emits.includes(sub.event)) {
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
        const actor = createActor(def.xstateMachine).start()
        this.appInstances.set(def.name, createInstanceProxy(def, actor))
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
