/**
 * describeMachine — a machine def serialized to plain data.
 *
 * The def already IS the statechart: states, per-state `on` maps, guards,
 * effects, emits, selectors and `serverOnly` are all present at runtime (only
 * the event-union *type* is erased). This walks that structure into a
 * JSON-able description — the SHAPE half of introspection. Consumers: the dev
 * inspector's machine view; later the manifest, `stator check`, and viz.
 *
 * Closures stay opaque by design: a guard/action/effect reports presence,
 * never its body. The walk normalizes the three authored transition forms
 * (bare action fn, config object, ordered candidate array) exactly as
 * `actor.send` does.
 */

import type {
  AnyMachineDef,
  EventObject,
  Lifecycle,
  OnMap,
  StateNode,
  Transition,
  TransitionConfig,
} from './types.ts'

export interface TransitionDescription {
  /** Target state; absent = self-transition (action only, no state change). */
  to?: string
  guarded: boolean
  action: boolean
  emits: string[]
  effect: boolean
}

export interface StateDescription {
  /** Event type → ordered guarded candidates (first whose guard passes wins). */
  on: Record<string, TransitionDescription[]>
  entry: boolean
  after: Array<{ delay: number | 'dynamic'; send: string }>
}

export interface MachineDescription {
  name: string
  lifecycle: Lifecycle
  persist: boolean
  initial: string
  states: Record<string, StateDescription>
  /** Machine-level fallback handlers (consulted when the state declares none). */
  on: Record<string, TransitionDescription[]>
  /** Every event type the chart handles somewhere (state ∪ machine level), sorted. */
  events: string[]
  serverOnly: string[]
  emits: string[]
  selectors: string[]
  reads: string[]
  subscribes: Array<{ from: string; event: string; dispatch: string }>
  /** The def's initial context (the shape a fresh instance starts from). */
  context: unknown
}

type AnyTransition = Transition<unknown, EventObject, string>
type AnyOnMap = OnMap<unknown, EventObject, string>

function describeTransitions(value: AnyTransition | AnyTransition[]): TransitionDescription[] {
  const candidates = Array.isArray(value) ? value : [value]
  return candidates.map((entry) => {
    // A bare function is sugar for `{ do: fn }` — same normalization as actor.send.
    const config: TransitionConfig<unknown, EventObject, string> =
      typeof entry === 'function' ? { do: entry } : entry
    const emits =
      config.emit === undefined ? [] : Array.isArray(config.emit) ? [...config.emit] : [config.emit]
    return {
      ...(config.to !== undefined ? { to: config.to } : {}),
      guarded: config.when !== undefined,
      action: config.do !== undefined,
      emits,
      effect: config.effect !== undefined,
    }
  })
}

function describeOn(on: AnyOnMap | undefined): Record<string, TransitionDescription[]> {
  const out: Record<string, TransitionDescription[]> = {}
  for (const [type, value] of Object.entries(on ?? {})) {
    if (value !== undefined) out[type] = describeTransitions(value as AnyTransition)
  }
  return out
}

/** Serialize a def to plain JSON-able data. Pure; never invokes app code. */
export function describeMachine(def: AnyMachineDef): MachineDescription {
  const states: Record<string, StateDescription> = {}
  for (const [name, node] of Object.entries(
    def.states as Record<string, StateNode<unknown, EventObject, string>>,
  )) {
    states[name] = {
      on: describeOn(node.on),
      entry: node.entry !== undefined,
      after: (node.after ?? []).map((a) => ({
        delay: typeof a.delay === 'number' ? a.delay : 'dynamic',
        send: a.send.type,
      })),
    }
  }
  const on = describeOn(def.on)
  const events = new Set<string>(Object.keys(on))
  for (const state of Object.values(states)) {
    for (const type of Object.keys(state.on)) events.add(type)
  }
  return {
    name: def.name,
    lifecycle: def.lifecycle,
    persist: def.persist,
    initial: def.initial,
    states,
    on,
    events: [...events].sort(),
    serverOnly: [...def.serverOnly],
    emits: Object.keys(def.emits),
    selectors: Object.keys(def.selectors),
    reads: def.reads.map((d) => d.name),
    subscribes: def.subscribes.map((s) => ({
      from: s.from.name,
      event: s.event,
      dispatch: typeof s.dispatch === 'string' ? s.dispatch : s.dispatch.type,
    })),
    context: def.context,
  }
}
