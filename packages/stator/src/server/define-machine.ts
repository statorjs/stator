import { assign, setup, emit as xstateEmit, type AnyStateMachine } from 'xstate'
import { getDispatchContext } from './dispatch-context.ts'

export type Lifecycle = 'app' | 'session'

export type SelectorMap<TContext> = Record<string, (ctx: TContext) => unknown>

/** The helpers an action or guard receives as its third argument.
 *  `reads.MachineName` is the live proxy for a machine listed in `reads:`. */
export interface ActionHelpers {
  reads: Record<string, any>
}

export type SubscribeEvent = string | { type: string; [k: string]: unknown }

export interface SubscribeEntry {
  from: MachineDef<any, any, any>
  event: string
  dispatch: SubscribeEvent
}

/**
 * Declaration for a single named emit. Payload selector runs synchronously
 * after the transition's actions (so it sees post-mutation context), with
 * the originating event. Must be pure of (context, event) — no external
 * reads, no async, no side effects. Returns extra fields that get merged
 * into the emitted event under `{ type: '<emit-name>', ...payload }`.
 *
 * Subscribers see the merged event, plus `sourceSessionId` automatically
 * injected when the subscription crosses a session→app lifecycle boundary.
 */
export interface EmitDeclaration<TContext = any, TEvent = any> {
  payload?: (context: TContext, event: TEvent) => Record<string, unknown>
}

/**
 * Object form: `{ EMIT_NAME: { payload?: ... } | null }` — null/empty means
 * "no payload, just the type." Array form: `['NAME', ...]` — shorthand for
 * the same. Both normalize to a `Record<string, EmitDeclaration>` internally.
 */
export type EmitsConfig<TContext = any, TEvent = any> =
  | readonly string[]
  | Record<string, EmitDeclaration<TContext, TEvent> | null>

function normalizeEmits(emits: EmitsConfig | undefined): Record<string, EmitDeclaration> {
  if (!emits) return {}
  if (Array.isArray(emits)) {
    const out: Record<string, EmitDeclaration> = {}
    for (const name of emits) out[name] = {}
    return out
  }
  const out: Record<string, EmitDeclaration> = {}
  for (const [name, decl] of Object.entries(emits)) {
    out[name] = decl ?? {}
  }
  return out
}

export interface DefineMachineConfig<
  TContext extends object,
  TSelectors extends SelectorMap<TContext>,
  TStateKey extends string,
> {
  name: string
  lifecycle: Lifecycle
  reads?: MachineDef<any, any, any>[]
  emits?: EmitsConfig<TContext>
  /** Other machines' emits this machine listens to. Each entry installs a
   *  listener on the `from` actor; when it fires `event`, `dispatch` is
   *  delivered to this machine. */
  subscribes?: SubscribeEntry[]
  context: TContext
  initial: NoInfer<TStateKey>
  states: Record<TStateKey, unknown>
  actions?: Record<string, (ctx: TContext, event: any, helpers: ActionHelpers) => void>
  guards?: Record<string, (ctx: TContext, event: any, helpers: ActionHelpers) => boolean>
  selectors?: TSelectors
}

export interface MachineDef<
  TContext extends object = any,
  TSelectors extends SelectorMap<TContext> = SelectorMap<TContext>,
  TStateKey extends string = string,
> {
  readonly __isStatorMachine: true
  name: string
  lifecycle: Lifecycle
  reads: MachineDef<any, any, any>[]
  /** Normalized form: every declared emit, possibly with a payload selector. */
  emits: Record<string, EmitDeclaration>
  subscribes: SubscribeEntry[]
  selectors: TSelectors
  xstateMachine: AnyStateMachine
  /** Type-level only carriers — never set at runtime. */
  readonly __context: TContext
  readonly __stateKey: TStateKey
}

export function defineMachine<
  TContext extends object,
  TSelectors extends SelectorMap<TContext>,
  TStateKey extends string,
>(
  config: DefineMachineConfig<TContext, TSelectors, TStateKey>,
): MachineDef<TContext, TSelectors, TStateKey> {
  const emits = normalizeEmits(config.emits)
  const states = transformEmits(config.states, emits, config.name) as Record<string, unknown>
  const reads = config.reads ?? []

  /** Resolve `reads:` proxies through the active dispatch context. If the
   *  action/guard runs without a dispatch (e.g. a unit test calling
   *  `actor.send` directly), `reads` is a Proxy that only throws when the
   *  action actually tries to dereference a read — actions that ignore the
   *  helpers keep working in test harnesses without going through
   *  `store.processEvent`. */
  const helpersForCurrentDispatch = (): ActionHelpers => {
    const dc = getDispatchContext()
    if (!dc) {
      return {
        reads: new Proxy({} as Record<string, unknown>, {
          get(_, prop) {
            throw new Error(
              `stator: "${config.name}" tried to access reads.${String(prop)} outside an active dispatch — ` +
                `actions/guards that use reads must be invoked through store.processEvent(...) ` +
                `(or actor.send() inside a subscription handler), not actor.send() directly.`,
            )
          },
        }),
      }
    }
    const readsMap: Record<string, any> = {}
    for (const r of reads) {
      const proxy = dc.runtime.proxyFor(r.name)
      if (!proxy) {
        throw new Error(
          `stator: "${config.name}" declares reads on "${r.name}" but it's not loaded ` +
            `in the active runtime — the runtime's loadGraph(...) should pull it in transitively.`,
        )
      }
      readsMap[r.name] = proxy
    }
    return { reads: readsMap }
  }

  const wrappedActions: Record<string, unknown> = {}
  for (const [name, userAction] of Object.entries(config.actions ?? {})) {
    wrappedActions[name] = assign(({ context, event }) => {
      const draft = structuredClone(context) as TContext
      userAction(draft, event, helpersForCurrentDispatch())
      return draft
    })
  }

  const wrappedGuards: Record<string, unknown> = {}
  for (const [name, userGuard] of Object.entries(config.guards ?? {})) {
    wrappedGuards[name] = ({ context, event }: { context: TContext; event: any }) =>
      userGuard(context, event, helpersForCurrentDispatch())
  }

  const xstateMachine = setup({
    actions: wrappedActions as never,
    guards: wrappedGuards as never,
  }).createMachine({
    id: config.name,
    context: config.context,
    initial: config.initial,
    states: states as never,
  })

  return {
    __isStatorMachine: true,
    name: config.name,
    lifecycle: config.lifecycle,
    reads: config.reads ?? [],
    emits,
    selectors: (config.selectors ?? ({} as TSelectors)),
    subscribes: config.subscribes ?? [],
    xstateMachine: xstateMachine as unknown as AnyStateMachine,
    __context: undefined as unknown as TContext,
    __stateKey: undefined as unknown as TStateKey,
  }
}

export function isStatorMachine(v: unknown): v is MachineDef {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__isStatorMachine === true
  )
}

/**
 * Walk the user's states config. For any transition node carrying `emit: 'X'`
 * (or `emit: ['X', 'Y']`), strip the `emit` key and append XState emit()
 * actions to the transition's `actions`. If the declared emit has a payload
 * selector, the emit action is the function form so XState invokes it at
 * transition time with the current context + originating event.
 *
 * Throws if a transition references an emit name not declared in the
 * machine's top-level `emits:` config — typos turn into clear errors and
 * the schema export sees every emit a machine can fire.
 */
function transformEmits(
  node: unknown,
  emits: Record<string, EmitDeclaration>,
  machineName: string,
): unknown {
  if (Array.isArray(node)) return node.map((n) => transformEmits(n, emits, machineName))
  if (!node || typeof node !== 'object') return node

  const obj = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'emit') continue
    out[k] = transformEmits(v, emits, machineName)
  }

  if ('emit' in obj) {
    const emitVal = obj.emit
    const names = Array.isArray(emitVal) ? emitVal : [emitVal]
    const emitActions: unknown[] = []
    for (const raw of names) {
      const name = String(raw)
      const decl = emits[name]
      if (!decl) {
        throw new Error(
          `stator: machine "${machineName}" has a transition that emits "${name}", ` +
            `but "${name}" is not declared in the machine's emits config. Add it to emits ` +
            `(with a payload selector if subscribers need data, or as a bare entry).`,
        )
      }
      if (decl.payload) {
        const payloadFn = decl.payload
        emitActions.push(
          xstateEmit(({ context, event }: { context: unknown; event: unknown }) => ({
            type: name,
            ...payloadFn(context, event),
          })),
        )
      } else {
        emitActions.push(xstateEmit({ type: name }))
      }
    }
    const existing = out.actions
    if (existing === undefined) {
      out.actions = emitActions.length === 1 ? emitActions[0] : emitActions
    } else if (Array.isArray(existing)) {
      out.actions = [...existing, ...emitActions]
    } else {
      out.actions = [existing, ...emitActions]
    }
  }
  return out
}
