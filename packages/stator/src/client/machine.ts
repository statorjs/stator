import { defineMachine, type MachineDef } from '../engine/index.ts'

/**
 * Terse machine form for component-local client state.
 *
 *   const Qty = machine(
 *     { count: 1 },                                  // context: just data
 *     {
 *       on: { INC: (s) => { s.count += 1 } },        // s is typed from context
 *       select: { atMax: (s) => s.count >= 99 },     // exposed on the instance
 *     },
 *   )
 *
 * Context and behavior are SEPARATE arguments so TypeScript can infer the
 * context first and then contextually type every handler and selector
 * against it — one bag can't be soundly inferred (the handlers' parameter
 * types would depend on the same object they're part of; see the probe
 * history in the 1.0 spec). Events are structurally loose (`ev.color` is
 * `unknown`); the machine desugars to a single-state `defineMachine`.
 *
 * Client machines run only via `createActor` (never the Store), so the name
 * is just a label and need not be unique.
 */

/** Client events are structurally loose — the terse form declares no union. */
export type ClientEvent = { type: string; [k: string]: unknown }

interface ClientTransitionObject<C> {
  when?: (ctx: C, ev: ClientEvent) => boolean
  do?: (ctx: C, ev: ClientEvent) => void
  emit?: string | string[]
}
type ClientTransition<C> = ((ctx: C, ev: ClientEvent) => void) | ClientTransitionObject<C>

export interface ClientBehavior<C> {
  /** Optional label (defaults to "ClientMachine"). */
  name?: string
  /** Transition map for the single implicit state. A bare function is an
   *  action; an object is a full `{ when?, do?, emit? }` transition. */
  on?: Record<string, ClientTransition<C>>
  /** Derived values, exposed as live properties on the `use()` instance. */
  select?: Record<string, (ctx: C) => unknown>
}

/** @deprecated One-bag form: context keys mixed with `on`/`select`. Kept for
 *  compatibility, but handlers see `any` — TypeScript cannot infer a
 *  context from the same object the handlers live in. Prefer
 *  `machine(context, behavior)`. */
export interface LegacyMachineConfig {
  name?: string
  // biome-ignore lint/suspicious/noExplicitAny: the one-bag form is untypeable by construction — that is exactly why the two-arg form exists
  on?: Record<string, ((ctx: any, ev: ClientEvent) => void) | ClientTransitionObject<any>>
  // biome-ignore lint/suspicious/noExplicitAny: same
  select?: Record<string, (ctx: any) => unknown>
  [key: string]: unknown
}

const RESERVED = new Set(['name', 'on', 'select'])

// Data-only: no behavior, no selectors.
export function machine<C extends Record<string, unknown>>(
  context: C & { on?: never; select?: never; name?: never },
): MachineDef<C, ClientEvent, 'active', Record<string, never>>
// Data + behavior: handlers and selectors typed against the context.
export function machine<
  C extends Record<string, unknown>,
  S extends Record<string, (ctx: C) => unknown>,
>(
  context: C & { on?: never; select?: never; name?: never },
  behavior: ClientBehavior<C> & { select?: S },
): MachineDef<C, ClientEvent, 'active', S>
/** @deprecated see LegacyMachineConfig */
export function machine(
  config: LegacyMachineConfig,
  // biome-ignore lint/suspicious/noExplicitAny: legacy view is deliberately loose
): MachineDef<Record<string, any>, ClientEvent, 'active', Record<string, (ctx: any) => any>>
export function machine(
  first: Record<string, unknown>,
  behavior?: ClientBehavior<never>,
): MachineDef {
  let context: Record<string, unknown>
  let name: string | undefined
  let on: Record<string, unknown>
  let select: Record<string, unknown>
  if (behavior !== undefined || !Object.keys(first).some((k) => RESERVED.has(k))) {
    context = first
    name = behavior?.name
    on = (behavior?.on ?? {}) as Record<string, unknown>
    select = (behavior?.select ?? {}) as Record<string, unknown>
  } else {
    // Legacy one-bag: context is every non-reserved key.
    const { name: n, on: o = {}, select: s = {}, ...rest } = first as LegacyMachineConfig
    context = rest
    name = n
    on = o as Record<string, unknown>
    select = s as Record<string, unknown>
  }
  return defineMachine({
    name: name ?? 'ClientMachine',
    lifecycle: 'session',
    events: {} as ClientEvent,
    context,
    initial: 'active',
    states: { active: { on: on as never } },
    selectors: select as never,
  }) as MachineDef
}
