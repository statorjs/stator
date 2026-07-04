import type {
  AnyMachineDef,
  Capabilities,
  EmitDeclaration,
  EmitsConfig,
  EventObject,
  Lifecycle,
  MachineDef,
  ReadsMap,
  SelectorMap,
  StateNode,
  SubscribeEntry,
} from './types.ts'

export interface DefineMachineConfig<
  C extends object,
  E extends EventObject,
  S extends string,
  Sel extends SelectorMap<C>,
  Name extends string,
  TReads extends readonly AnyMachineDef[],
> {
  name: Name
  lifecycle: Lifecycle
  /** Machines this one reads. Inferred as a tuple so `helpers.reads` is typed
   *  per read machine (keyed by name, selectors preserved). */
  reads?: TReads
  subscribes?: SubscribeEntry[]
  /** Typed event surface. Pass `{} as MyEvents` — a phantom carrier the engine
   *  reads only for its type. Actions/guards then narrow per transition. */
  events?: E
  emits?: EmitsConfig<C, E>
  context: C
  initial: NoInfer<S>
  /** Transitions see `helpers.reads` typed as `ReadsMap<TReads>`. */
  states: Record<S, StateNode<C, E, S, ReadsMap<TReads>>>
  selectors?: Sel
  /** APP machines only: persist this machine's snapshot through the AppStore
   *  so its state survives restarts. Opt-in — caches and other
   *  reset-on-restart machines should leave it off. Session machines always
   *  persist through the session Store; setting this on one is an error. */
  persist?: boolean
}

function normalizeEmits<C, E extends EventObject>(
  emits: EmitsConfig<C, E> | undefined,
): Record<string, EmitDeclaration<C, E>> {
  if (!emits) return {}
  const out: Record<string, EmitDeclaration<C, E>> = {}
  if (Array.isArray(emits)) {
    for (const name of emits) out[name] = {}
    return out
  }
  for (const [name, decl] of Object.entries(
    emits as Record<string, EmitDeclaration<C, E> | null>,
  )) {
    out[name] = decl ?? {}
  }
  return out
}

/**
 * Derive the machine's capability classification.
 *
 * Initial heuristic (refined in the full capability pass): a machine is
 * server-pinned if it reads another machine — cross-machine reads can't be
 * resolved in the browser. A pure context/states/selectors machine with no
 * reads is portable (the client-model spike's reads-free counter ran
 * client-side for exactly this reason). Secrets and cross-session emit are
 * future inputs to this function; they're noted as TODO, not silently ignored.
 */
function computeCapabilities(reads: readonly AnyMachineDef[]): Capabilities {
  const reasons: string[] = []
  for (const r of reads) {
    reasons.push(`reads machine "${r.name}" (cross-machine reads resolve server-side only)`)
  }
  // TODO(capability-pass): also flag secret access and cross-session emit.
  return { serverPinned: reasons.length > 0, reasons }
}

export function defineMachine<
  C extends object,
  E extends EventObject = EventObject,
  S extends string = string,
  Sel extends SelectorMap<C> = SelectorMap<C>,
  Name extends string = string,
  const TReads extends readonly AnyMachineDef[] = readonly [],
>(config: DefineMachineConfig<C, E, S, Sel, Name, TReads>): MachineDef<C, E, S, Sel, Name> {
  const reads = (config.reads ?? []) as unknown as AnyMachineDef[]
  if (config.persist && config.lifecycle === 'session') {
    throw new Error(
      `stator: machine "${config.name}" sets persist: true but is session-lifecycle — ` +
        `session machines always persist through the session Store. ` +
        `\`persist\` opts an APP machine into AppStore persistence.`,
    )
  }
  return {
    __isStatorMachine: true,
    name: config.name,
    lifecycle: config.lifecycle as Lifecycle,
    persist: config.persist ?? false,
    reads,
    subscribes: config.subscribes ?? [],
    emits: normalizeEmits<C, E>(config.emits),
    selectors: (config.selectors ?? {}) as Sel,
    capabilities: computeCapabilities(reads),
    initial: config.initial,
    states: config.states as Record<string, StateNode<C, E, S>>,
    context: config.context,
    __context: undefined as unknown as C,
    __event: undefined as unknown as E,
  }
}
