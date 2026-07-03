import { createActor, type Snapshot } from '../engine/index.ts'
import type { MachineDef } from './define-machine.ts'
import { type DispatchContext, recordTouch, withDispatchContext } from './dispatch-context.ts'
import { createInstanceProxy, type InstanceHandle } from './instance-proxy.ts'
import { buildDispatchEvent, type MachineStore } from './machine-store.ts'
import { serverReadsResolver } from './reads-helpers.ts'

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
    const actor = createActor(def, {
      snapshot: persisted !== null ? (persisted as Snapshot<any>) : undefined,
      resolveHelpers: serverReadsResolver(def),
    }).start()
    this.actors.set(def.name, createInstanceProxy(def, actor))
  }

  /**
   * Install actor.on listeners for every subscription whose source is a
   * session-machine loaded in this runtime. The target may be:
   *   - another session-machine in this runtime (session→session)
   *   - an app-machine in the long-lived appInstances (session→app)
   * App→session is blocked at validation; app→app is wired at app boot.
   *
   * Cross-lifecycle (session→app) subscriptions inject `sourceSessionId`
   * into the dispatched event so the app receiver can correlate which
   * session emitted it.
   *
   * Must be called before any event is sent. Idempotent.
   */
  wireSubscriptions(): void {
    if (this.wired) return
    this.wired = true

    for (const [sourceName, sourceHandle] of this.actors) {
      for (const sub of this.store.subscribersOf(sourceName)) {
        const targetDef = this.store.getDef(sub.targetName)
        if (!targetDef) continue
        const targetHandle =
          targetDef.lifecycle === 'app'
            ? this.store.appInstance(sub.targetName)
            : this.actors.get(sub.targetName)
        if (!targetHandle) continue

        const crossLifecycle = sourceHandle.def.lifecycle !== targetDef.lifecycle
        const sid = this.sessionId
        const targetName = sub.targetName

        sourceHandle.actor.on(sub.event as never, (emitted: any) => {
          targetHandle.actor.send(
            buildDispatchEvent(emitted, sub.dispatch, crossLifecycle ? sid : undefined) as never,
          )
          recordTouch(targetName)
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
  processEvent(machineName: string, event: { type: string; [k: string]: unknown }): Set<string> {
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
    const ttlSeconds = this.store.sessionTtlSeconds
    for (const name of touched) {
      const handle = this.actors.get(name)
      if (!handle) continue
      const snapshot = handle.actor.getPersistedSnapshot()
      // Every set refreshes the session's whole expiry — the user is
      // active, so all of their machines stay alive together.
      await this.store.persistence.set(this.sessionId, name, snapshot, {
        ttlSeconds,
      })
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
