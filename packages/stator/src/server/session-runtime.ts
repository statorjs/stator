import { createActor, type EffectInvocation, type Snapshot } from '../engine/index.ts'
import type { AnyMachineDef } from './define-machine.ts'
import { type DispatchContext, recordTouch, withDispatchContext } from './dispatch-context.ts'
import { createInstanceProxy, type InstanceHandle } from './instance-proxy.ts'
import { buildDispatchEvent, MAX_CASCADE_DEPTH, type MachineStore } from './machine-store.ts'
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
  /** Synchronous emit→subscribe cascade depth + trail for THIS runtime. A
   *  subscription cycle would otherwise recurse to a bare stack overflow;
   *  the cap converts it into an error that names the loop. */
  private cascadeDepth = 0
  private cascadeTrail: string[] = []
  /** Effects surfaced during processEvent, queued until the entry point has
   *  persisted and released the session lock (see server/effects.ts). */
  private pendingEffects: EffectInvocation[] = []

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
  async loadGraph(seeds: ReadonlyArray<AnyMachineDef>): Promise<void> {
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

  private async loadOne(def: AnyMachineDef): Promise<void> {
    const persisted = await this.store.persistence.get(this.sessionId, def.name)
    const actor = createActor(def, {
      snapshot: persisted !== null ? (persisted as Snapshot<object>) : undefined,
      resolveHelpers: serverReadsResolver(def),
      // Server plane: never run effects inline — queue them for the entry
      // point to schedule after persist + lock release.
      onEffect: (invocation) => this.pendingEffects.push(invocation),
    }).start()
    this.actors.set(def.name, createInstanceProxy(def, actor))
  }

  /**
   * Replace a session actor with a fresh hydration from the Store. Used by
   * fan-out before recomputing a long-lived SSE connection's diffs: the
   * mutation happened in ANOTHER runtime (a POST or an effect completion)
   * and only exists in persistence — this runtime's in-memory actor is
   * frozen at whatever the connection last saw. Subscription listeners are
   * NOT rewired onto the new actor; connection runtimes are read-only diff
   * targets and never dispatch.
   */
  async rehydrate(name: string): Promise<void> {
    const def = this.store.getDef(name)
    if (def?.lifecycle !== 'session' || !this.actors.has(name)) return
    const persisted = await this.store.persistence.get(this.sessionId, def.name)
    const actor = createActor(def, {
      snapshot: persisted !== null ? (persisted as Snapshot<object>) : undefined,
      resolveHelpers: serverReadsResolver(def),
      onEffect: (invocation) => this.pendingEffects.push(invocation),
    }).start()
    this.actors.get(name)?.actor.stop()
    this.actors.set(name, createInstanceProxy(def, actor))
  }

  /** Lifecycle of a machine by name, for fan-out applicability decisions. */
  lifecycleOf(name: string): 'session' | 'app' | undefined {
    return this.store.getDef(name)?.lifecycle
  }

  /** Hand queued effect invocations to the scheduler, clearing the queue. */
  drainPendingEffects(): EffectInvocation[] {
    const drained = this.pendingEffects
    this.pendingEffects = []
    return drained
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

        sourceHandle.actor.on(sub.event as never, (emitted) => {
          this.cascadeDepth += 1
          this.cascadeTrail.push(`${sourceName} —${sub.event}→ ${targetName}`)
          try {
            if (this.cascadeDepth > MAX_CASCADE_DEPTH) {
              throw new Error(
                `stator: emit cascade exceeded ${MAX_CASCADE_DEPTH} hops — ` +
                  `subscription cycle? Last hops:\n  ${this.cascadeTrail.slice(-6).join('\n  ')}`,
              )
            }
            targetHandle.actor.send(
              buildDispatchEvent(emitted, sub.dispatch, crossLifecycle ? sid : undefined) as never,
            )
            recordTouch(targetName)
          } finally {
            this.cascadeDepth -= 1
            this.cascadeTrail.pop()
          }
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

  /** Write the current persisted snapshot for each touched machine back to
   *  its store: session machines to the session Store, app machines (touched
   *  via session→app subscriptions) to the AppStore when they opted in. */
  async persistTouched(touched: ReadonlySet<string>): Promise<void> {
    const ttlSeconds = this.store.sessionTtlSeconds
    for (const name of touched) {
      const handle = this.actors.get(name)
      if (!handle) {
        // Not a session machine in this runtime — an app machine reached via
        // subscription. Safe no-op unless it opted into persistence.
        await this.store.persistAppMachine(name)
        continue
      }
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
