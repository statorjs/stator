import { createActor, type AnyStateMachine } from 'xstate'
import type { MachineDef } from './define-machine.ts'
import { createInstanceProxy, type InstanceHandle } from './instance-proxy.ts'
import type { MachineStore } from './machine-store.ts'
import {
  recordTouch,
  withDispatchContext,
  type DispatchContext,
} from './dispatch-context.ts'

/**
 * Per-request scope for session-lifecycle machine actors. Created at the
 * top of an HTTP handler, populated by `loadGraph` (which pulls only the
 * machines this request needs from the Store and hydrates transient
 * actors), and disposed at the bottom of the handler.
 *
 * Subscription wiring uses cross-actor listeners installed via
 * `actor.on(...)`. Because the actors are transient, the wiring is rebuilt
 * per request — never reused across requests.
 *
 * Same shape will host SSE connection lifetime in V1: the connection's
 * runtime simply lives longer (one runtime per open connection, not one
 * per request), and `processEvent` is invoked when an out-of-band state
 * change touches a machine the connection's route reads.
 */
export class SessionRuntime {
  private actors = new Map<string, InstanceHandle>()
  private wired = false

  constructor(
    readonly sessionId: string,
    readonly store: MachineStore,
  ) {}

  /**
   * Ensure the given machines (and everything reachable via their `reads:`
   * and `subscribes:` declarations + machines that subscribe back to them)
   * are loaded into this runtime. Idempotent: calling twice with overlapping
   * inputs costs only the de-duped delta.
   */
  async loadGraph(seeds: ReadonlyArray<MachineDef<any, any>>): Promise<void> {
    const queue = [...seeds]
    while (queue.length > 0) {
      const def = queue.shift()!
      if (def.lifecycle !== 'session') continue
      if (this.actors.has(def.name)) continue
      await this.loadOne(def)
      queue.push(...def.reads)
      for (const sub of def.subscribes) queue.push(sub.from)
      for (const sub of this.store.subscribersOf(def.name)) {
        const targetDef = this.store.getDef(sub.targetName)
        if (targetDef) queue.push(targetDef)
      }
    }
  }

  private async loadOne(def: MachineDef<any, any>): Promise<void> {
    const persisted = await this.store.persistence.get(this.sessionId, def.name)
    const opts = persisted !== null ? { snapshot: persisted as never } : undefined
    const actor = createActor(def.xstateMachine as AnyStateMachine, opts).start()
    this.actors.set(def.name, createInstanceProxy(def, actor))
  }

  /**
   * Install actor.on listeners for every `subscribes:` declaration whose
   * source + target both live in this runtime. Must be called before any
   * event is sent. Idempotent.
   */
  wireSubscriptions(): void {
    if (this.wired) return
    this.wired = true
    for (const [name, handle] of this.actors) {
      for (const sub of handle.def.subscribes) {
        const sourceHandle = this.actors.get(sub.from.name)
        if (!sourceHandle) continue
        const dispatch =
          typeof sub.dispatch === 'string' ? { type: sub.dispatch } : sub.dispatch
        sourceHandle.actor.on(sub.event as never, () => {
          handle.actor.send(dispatch as never)
          recordTouch(name)
        })
      }
    }
  }

  /** Resolve a proxy for a machine — session-scoped from this runtime,
   *  app-scoped from the long-lived app instance map. */
  proxyFor(name: string): unknown {
    const local = this.actors.get(name)
    if (local) return local.proxy
    const app = this.store.appInstance(name)
    return app?.proxy
  }

  handleFor(name: string): InstanceHandle | undefined {
    return this.actors.get(name) ?? this.store.appInstance(name)
  }

  /**
   * Send an event to a loaded machine. Returns the set of machine names
   * whose actors received any event during the dispatch (the origin plus
   * any subscriber targets that fired via cross-machine listeners).
   *
   * Throws if the origin machine isn't loaded — call `loadGraph` first.
   */
  processEvent(
    machineName: string,
    event: { type: string; [k: string]: unknown },
  ): Set<string> {
    const handle = this.actors.get(machineName)
    if (!handle) {
      throw new Error(
        `stator: machine "${machineName}" is not loaded into this runtime — ` +
          `call loadGraph(...) with the relevant defs first.`,
      )
    }
    if (!this.wired) this.wireSubscriptions()
    const ctx: DispatchContext = {
      runtime: this,
      touched: new Set<string>([machineName]),
    }
    withDispatchContext(ctx, () => {
      handle.actor.send(event as never)
    })
    return ctx.touched
  }

  /** Write the current persisted snapshot for each touched session machine
   *  back to the Store. App-machine touches (rare; the POC doesn't emit
   *  events to app machines) are not persisted. */
  async persistTouched(touched: ReadonlySet<string>): Promise<void> {
    for (const name of touched) {
      const handle = this.actors.get(name)
      if (!handle) continue
      const snapshot = handle.actor.getPersistedSnapshot()
      await this.store.persistence.set(this.sessionId, name, snapshot)
    }
  }

  /** Stop every transient actor. After dispose, the runtime must not be
   *  used. Safe to call multiple times. */
  dispose(): void {
    for (const handle of this.actors.values()) {
      handle.actor.stop()
    }
    this.actors.clear()
  }
}

