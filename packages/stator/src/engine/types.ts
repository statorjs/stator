// biome-ignore-all lint/suspicious/noExplicitAny: type-level plumbing — existential machine slots and loose internal defaults require `any`; see the AnyMachineDef comment for the variance argument
/**
 * Stator's own state-machine engine — core types.
 *
 * Designed fresh for Stator's needs, NOT for XState compatibility. The shape is
 * a declarative `states` map (so the transition graph stays statically
 * analyzable — the framework's core value), with inline functions on
 * transitions (Option A: per-transition event narrowing, co-located logic).
 *
 * Lean feature set per the engine spec: flat states, typed events, guards,
 * mutation-style actions, declared emits, selectors, snapshot ser/de. State
 * value is a PATH ARRAY (`['active']`) — depth-1 today, the extension point for
 * hierarchy later without a rewrite.
 *
 * Reads are type-safe by inference: a machine that `reads` others gets a typed
 * `helpers.reads` map keyed by each read machine's `name`, with that machine's
 * selectors (and their return types) preserved. See `ReadsMap` / `InstanceOf`.
 */

/** Every event is a discriminated union member keyed on `type`. */
export type EventObject = { type: string }

export type SelectorMap<C> = Record<string, (ctx: C) => unknown>

/** Helpers handed to actions/guards. `reads` is the typed map of machines
 *  declared in `reads:` (see `ReadsMap`). Defaults loose for internal/runtime
 *  use where the concrete map isn't threaded. */
export interface ActionHelpers<R = Record<string, any>> {
  reads: R
}

/** An action mutates a draft of the context in place. The engine owns the
 *  clone + commit, so user code writes plain mutation. */
export type Action<C, E extends EventObject, R = Record<string, any>> = (
  ctx: C,
  ev: E,
  helpers: ActionHelpers<R>,
) => void

/** A guard decides whether a transition may fire. Pure of (ctx, ev). */
export type Guard<C, E extends EventObject, R = Record<string, any>> = (
  ctx: C,
  ev: E,
  helpers: ActionHelpers<R>,
) => boolean

/** Passed to an effect alongside the snapshots. `effectId` is unique per
 *  invocation — thread it to external calls as an idempotency key (1.x
 *  durability implies at-least-once) and use it for log correlation. */
export interface EffectMeta {
  effectId: string
}

/**
 * An effect: async I/O declared on a transition, run by the HOST after the
 * transition commits (the engine itself never performs I/O). Receives
 * commit-time `structuredClone` snapshots of context and event — never live
 * state — plus meta. Returns the completion event to dispatch (typed against
 * the machine's full event union), or null for fire-and-forget.
 *
 * Effects are infallible by construction: catch inside and return your
 * declared failure event. A throw is the runtime backstop — logged and
 * dropped, never a crash. See the engine-effects spec.
 *
 * Authoring note: annotate the effect's return type with your machine's event
 * union — `effect: async (ctx, ev, meta): Promise<Events | null> => …`.
 * TypeScript defers context-sensitive arrows during `defineMachine`'s generic
 * inference, so an unannotated return widens its event literals and fails to
 * typecheck (loudly — never silently unchecked). The annotation restores full
 * checking: an undeclared completion event type is a compile error.
 */
export type Effect<C, E extends EventObject, EAll extends EventObject = EventObject> = (
  ctx: C,
  ev: E,
  meta: EffectMeta,
) => Promise<EAll | null>

/** A scheduled effect surfaced to the host: everything needed to run it and
 *  dispatch its completion. `run` closes over the commit-time snapshots. */
export interface EffectInvocation {
  machineName: string
  effectId: string
  run: () => Promise<EventObject | null>
}

/** Object form of a transition. A bare `Action` is sugar for `{ do: fn }`.
 *  `E` is the event narrowed to this `on` key; `EAll` is the machine's full
 *  event union (what an effect's completion event is typed against). */
export interface TransitionConfig<
  C,
  E extends EventObject,
  S extends string,
  R = Record<string, any>,
  EAll extends EventObject = EventObject,
> {
  /** Target state. Omit for a self-transition (action only, no state change). */
  to?: S
  /** Guard — transition is skipped if it returns false. */
  when?: Guard<C, E, R>
  /** Action — mutates the draft context. */
  do?: Action<C, E, R>
  /** Declared emit(s) to fire after the action commits. */
  emit?: string | string[]
  /** Async I/O, host-scheduled after commit. See `Effect`. */
  effect?: Effect<C, E, EAll>
}

export type Transition<
  C,
  E extends EventObject,
  S extends string,
  R = Record<string, any>,
  EAll extends EventObject = EventObject,
> = Action<C, E, R> | TransitionConfig<C, E, S, R, EAll>

/** The `on` map: each event type maps to a transition (or an ordered array of
 *  guarded candidates — first whose `when` passes wins) whose action/guard see
 *  the event NARROWED to exactly that type. This is the Option A payoff. */
export type OnMap<C, E extends EventObject, S extends string, R = Record<string, any>> = {
  [K in E['type']]?:
    | Transition<C, Extract<E, { type: K }>, S, R, E>
    | Array<Transition<C, Extract<E, { type: K }>, S, R, E>>
}

export interface StateNode<C, E extends EventObject, S extends string, R = Record<string, any>> {
  on?: OnMap<C, E, S, R>
}

/** Payload selector runs synchronously AFTER the transition's action, so it
 *  sees post-mutation context. Pure of (ctx, ev). The event is typed `any`
 *  because an emit may fire from several transitions carrying different events;
 *  the originating event isn't statically pinned to one union member. (Tighter
 *  emit typing is tracked as an open question on the engine spec.) */
export interface EmitDeclaration<C, _E extends EventObject = EventObject> {
  payload?: (ctx: C, ev: any) => Record<string, unknown>
}

export type EmitsConfig<C, E extends EventObject> =
  | readonly string[]
  | Record<string, EmitDeclaration<C, E> | null>

/** A machine's capability classification. `serverPinned` means it may not be
 *  placed on the client; `reasons` explains why (surfaced in compile errors). */
export interface Capabilities {
  serverPinned: boolean
  reasons: string[]
}

/** Compact, engine-owned snapshot. Serializes for the Store (server sessions)
 *  and seeds a client actor on custom-element upgrade (hydration). */
export interface Snapshot<C> {
  /** State path. Depth-1 today (`['idle']`); extensible to hierarchy. */
  value: string[]
  context: C
}

export type Lifecycle = 'app' | 'session'

/** Cross-machine subscription entry (carried through unchanged from the POC
 *  model; the glue layer consumes it). */
export interface SubscribeEntry {
  from: AnyMachineDef
  event: string
  dispatch: string | { type: string; [k: string]: unknown }
}

export interface MachineDef<
  C = any,
  E extends EventObject = any,
  S extends string = string,
  Sel extends SelectorMap<C> = SelectorMap<C>,
  Name extends string = string,
> {
  readonly __isStatorMachine: true
  name: Name
  lifecycle: Lifecycle
  /** APP machines only: snapshot persists through the AppStore across
   *  restarts (opt-in; see DefineMachineConfig.persist). */
  persist: boolean
  reads: AnyMachineDef[]
  subscribes: SubscribeEntry[]
  /** Normalized: every declared emit, possibly with a payload selector. */
  emits: Record<string, EmitDeclaration<C, E>>
  selectors: Sel
  capabilities: Capabilities
  initial: string
  /** Engine internals — the transition graph (R erased post-construction; the
   *  reads typing that matters is enforced at the authoring callsite) and the
   *  initial context. */
  states: Record<string, StateNode<C, E, S>>
  context: C
  /** Type-level carriers — never read at runtime. */
  readonly __context: C
  readonly __event: E
}

/** The "top type" for a machine def — used wherever a heterogeneous collection
 *  of machines is held (e.g. `reads`). `any` in the slots is deliberate:
 *  `MachineDef` is invariant in its context (context appears in contravariant
 *  action-parameter positions), so a specific `MachineDef<{...}>` is NOT
 *  assignable to `MachineDef<unknown>` — only `any` admits every concrete def.
 *  Callsite type-safety is recovered via `ReadsMap` inference, not here. */
export type AnyMachineDef = MachineDef<any, any, any, any, any>

/** The instance-facing shape of a machine: each selector exposed as a property
 *  carrying that selector's return type (callable if the selector returns a
 *  function). This is what `helpers.reads.<Name>` resolves to. */
export type InstanceOf<TDef extends AnyMachineDef> =
  TDef extends MachineDef<any, any, any, infer Sel, any>
    ? { readonly [K in keyof Sel]: ReturnType<Sel[K]> }
    : never

/** Build the typed `helpers.reads` map from a tuple of read machines: keyed by
 *  each machine's literal `name`, valued by its instance type. */
export type ReadsMap<TReads extends readonly AnyMachineDef[]> = {
  [M in TReads[number] as M['name']]: InstanceOf<M>
}

/** The event union a machine accepts — used to type machine-mediated dispatch
 *  (`dispatch(Machine, event)`) against the imported def. */
export type EventOf<D extends AnyMachineDef> =
  D extends MachineDef<any, infer E, any, any, any> ? E : never

export function isStatorMachine(v: unknown): v is AnyMachineDef {
  return (
    typeof v === 'object' && v !== null && (v as Record<string, unknown>).__isStatorMachine === true
  )
}
