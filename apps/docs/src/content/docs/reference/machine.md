---
title: "machine"
description: "The isomorphic state-machine engine: defineMachine, createActor, and the effect types."
sidebar:
  order: 3
---

`@statorjs/stator/machine` is the engine itself — browser-safe (no server imports), running identically on the server and in a client island.

## defineMachine

```ts
function defineMachine(config: DefineMachineConfig): MachineDef

// config fields
{
  name: string
  lifecycle: 'app' | 'session'
  context: C                    // initial context
  initial: S                    // initial state name
  states: Record<S, { on?: OnMap }>
  events?: E                    // typed event surface — pass `{} as MyEvents`
  selectors?: Record<string, (ctx: C) => unknown>
  reads?: MachineDef[]          // machines this one reads (typed helpers.reads)
  subscribes?: SubscribeEntry[] // cross-machine subscriptions
  emits?: string[] | Record<string, { payload?: (ctx, ev) => object }>
  persist?: boolean             // app machines only: survive restarts via the AppStore
}
```

Defines a machine: flat states, typed events, and inline transitions. `events` is a phantom carrier — the engine reads only its type, and each transition's action/guard then sees the event **narrowed** to exactly its `on` key. A machine that declares `reads` gets a typed `helpers.reads` map (keyed by machine name, selectors preserved) in its actions and guards — and becomes server-pinned, since cross-machine reads can't resolve in the browser. `persist: true` on a session machine is an error; sessions always persist through the session `Store`.

Each entry in an `on` map is a transition (or an ordered array of guarded candidates — first passing `when` wins):

```ts
{
  to?: S                        // target state; omit for a self-transition
  when?: (ctx, ev, helpers) => boolean
  do?: (ctx, ev, helpers) => void   // mutates a draft; the engine owns clone + commit
  emit?: string | string[]      // declared emits fired after the action commits
  effect?: (ctx, ev, meta) => Promise<Events | null>
}
```

A bare function is sugar for `{ do: fn }`.

## createActor

```ts
function createActor(def: MachineDef, opts?: CreateActorOptions): Actor

interface CreateActorOptions {
  snapshot?: Snapshot           // hydrate from persisted state or a client seed
  resolveHelpers?: () => ActionHelpers  // host-provided `reads` resolver
  onEffect?: (invocation: EffectInvocation) => void  // host effect scheduler
}

interface Actor<C, E> {
  start(): Actor<C, E>
  stop(): void
  send(event: E): void
  seed(partial: Partial<C>): void   // merge into context before start(); no-op after
  getSnapshot(): Snapshot<C>
  getPersistedSnapshot(): Snapshot<C>
  subscribe(listener: (snapshot: Snapshot<C>) => void): { unsubscribe(): void }
  on(emitName: string, listener: (event) => void): () => void
}
```

Instantiates a running machine. The two injection points are what keep the engine isomorphic: the server wires `resolveHelpers` to the active dispatch context and `onEffect` to its post-commit queue; the client omits both, so effects run locally on a microtask and a `reads` dereference throws with a clear error. You call this directly in unit tests; the framework calls it everywhere else.

## Effects

```ts
type Effect = (ctx: C, ev: E, meta: EffectMeta) => Promise<Events | null>

interface EffectMeta { effectId: string }

interface EffectInvocation {
  machineName: string
  effectId: string
  run: () => Promise<EventObject | null>
}
```

An effect is async I/O declared on a transition and run by the **host** after the transition commits — the engine itself never performs I/O. It receives `structuredClone` snapshots of context and event taken at commit time (never live state), plus `{ effectId }`, unique per invocation — thread it to external calls as an idempotency key and use it for log correlation. Return the completion event to dispatch, or `null` for fire-and-forget.

Two rules to know:

- **Annotate the return type**: `effect: async (ctx, ev, meta): Promise<Events | null> => …`. TypeScript defers context-sensitive arrows during `defineMachine`'s inference, so an unannotated effect fails to typecheck; the annotation restores full checking of the completion event against your event union.
- **Effects are infallible by construction**: catch inside and return your declared failure event. A throw is the runtime backstop — logged and dropped, never a crash.

## Lower-level exports

Type-level plumbing, exported for tooling and advanced typing:

- `EventObject` — the base event shape (`{ type: string }`).
- `EventOf<Def>` — a machine's event union; what `dispatch(Machine, event)` checks against.
- `InstanceOf<Def>` — a machine's instance shape (each selector as a typed property).
- `ReadsMap<Reads>` — the typed `helpers.reads` map built from a `reads` tuple.
- `Snapshot<C>` — `{ value: string[]; context: C }`; serializes to the Store and seeds client hydration.
- `Action`, `Guard`, `ActionHelpers` — the function shapes transitions are built from.
- `Transition`, `TransitionConfig`, `StateNode` — the transition-graph node types.
- `EmitDeclaration`, `EmitsConfig` — normalized emit declarations.
- `SubscribeEntry` — a cross-machine subscription entry.
- `Capabilities` — `{ serverPinned, reasons }`; why a machine can't run client-side.
- `Lifecycle` — `'app' | 'session'`.
- `MachineDef`, `AnyMachineDef`, `AnyActor` — the def/actor types and their heterogeneous-collection "top types".
- `isStatorMachine` — brand guard for a machine def.
