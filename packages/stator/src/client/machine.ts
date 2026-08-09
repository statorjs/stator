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

/** The loose client event shape — the fallback when a machine declares no
 *  union and has no `on` map to derive one from. */
export type ClientEvent = { type: string; [k: string]: unknown }

/** Event-name union derived from an `on` map: the NAMES are typed (a `send`
 *  typo is a compile error), payloads stay structurally open. The
 *  zero-ceremony tier of client event typing. */
export type DerivedEvents<O> = {
  [K in keyof O & string]: { type: K } & Record<string, unknown>
}[keyof O & string]

/** The `on` map for a machine with a DECLARED event union: keys are the
 *  declared event names, and each handler sees its event narrowed — no
 *  annotations needed. Mirrors the server `defineMachine` experience. */
export type TypedClientOnMap<C, E extends { type: string }> = {
  [K in E['type']]?:
    | ((ctx: C, ev: Extract<E, { type: K }>) => void)
    | {
        when?: (ctx: C, ev: Extract<E, { type: K }>) => boolean
        do?: (ctx: C, ev: Extract<E, { type: K }>) => void
        emit?: string | string[]
      }
}

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

// Data-only: no behavior. Events stay structurally LOOSE (ClientEvent) on
// purpose: data-only machines are the `bind:value` / hand-written `@set`
// carriers until 2.0 removes `@set` — tightening them now would break that
// still-supported surface. Tighten to `never` when `@set` goes.
export function machine<C extends Record<string, unknown>>(
  context: C & { on?: never; select?: never; name?: never; events?: never },
): MachineDef<C, ClientEvent, 'active', Record<string, never>>
// Derived union — no `events:` declared: event NAMES come from the `on` keys
// (typo-safe send), payloads stay open. Zero authoring change. Ordered BEFORE
// the declared overload: `events?: never` keeps declared calls falling through.
export function machine<
  C extends Record<string, unknown>,
  O extends Record<string, ClientTransition<C>>,
  S extends Record<string, (ctx: C) => unknown>,
>(
  context: C & { on?: never; select?: never; name?: never; events?: never },
  behavior: { name?: string; events?: never; on: O; select?: S },
): MachineDef<C, DerivedEvents<O>, 'active', S>
// Declared union (`events: {} as E`) — mirrors defineMachine: full payload
// typing on send, handlers narrowed per key, undeclared handler keys error.
export function machine<
  C extends Record<string, unknown>,
  E extends { type: string },
  S extends Record<string, (ctx: C) => unknown>,
>(
  context: C & { on?: never; select?: never; name?: never; events?: never },
  behavior: { name?: string; events: E; on?: TypedClientOnMap<C, E>; select?: S },
): MachineDef<C, E, 'active', S>
// Behavior without `on` (selectors only): loose, as data-only.
export function machine<
  C extends Record<string, unknown>,
  S extends Record<string, (ctx: C) => unknown>,
>(
  context: C & { on?: never; select?: never; name?: never; events?: never },
  behavior: { name?: string; events?: never; on?: never; select?: S },
): MachineDef<C, ClientEvent, 'active', S>
/** @deprecated see LegacyMachineConfig */
export function machine(
  config: LegacyMachineConfig,
  // biome-ignore lint/suspicious/noExplicitAny: legacy view is deliberately loose
): MachineDef<Record<string, any>, ClientEvent, 'active', Record<string, (ctx: any) => any>>
export function machine(
  first: Record<string, unknown>,
  // Loose impl signature: the overloads above are the contract. `events` is a
  // type-only phantom (`{} as E`) — the runtime never reads it.
  rawBehavior?: unknown,
): MachineDef {
  const behavior = rawBehavior as (ClientBehavior<never> & { events?: unknown }) | undefined
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
