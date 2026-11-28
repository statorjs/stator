---
title: "machine"
description: "The isomorphic state-machine engine: defineMachine, createActor, and the effect types."
sidebar:
  order: 3
---

`@statorjs/stator/machine` is the engine itself — browser-safe (no server imports), running identically on the server and in a client island. It is the only entry that exports `defineMachine`: every machine imports it from here, and nothing in the import says where the machine runs.

## defineMachine

```ts
function defineMachine(config: DefineMachineConfig): MachineDef

// config fields
{
  name: string
  lifecycle: 'app' | 'session'
  context: C                    // initial context
  initial: S                    // initial state name
  states: Record<S, { on?: OnMap; entry?: EntryEffect; after?: AfterEntry[] }>
  on?: OnMap                    // machine-level transitions: apply in ANY state, consulted only
                                // when the current state doesn't declare the event (a state-
                                // scoped handler always wins, even if its guard drops)
  events?: E                    // typed event surface — pass `{} as MyEvents`
  selectors?: Record<string, (ctx: C, helpers?) => unknown>  // helpers.peers for cross-machine views
  peers?: MachineDef[]          // machines this one consults (typed helpers.peers); 3.1+
  reads?: MachineDef[]          // deprecated: the old name of peers, removed in 4.0
  subscribes?: SubscribeEntry[] // cross-machine subscriptions
  emits?: string[] | Record<string, { payload?: (ctx, ev) => object }>
  persist?: boolean             // app machines only: survive restarts (while the machine's
                                // code is unchanged) via the AppStore
  seed?: (session) => { state?: S; context?: Partial<C> } | undefined
                                // session machines only: where a fresh start begins, given
                                // the session's claims (see below)
}
```

Defines a machine: flat states, typed events, and inline transitions. `events` is a phantom carrier — the engine reads only its type, and each transition's action/guard then sees the event **narrowed** to exactly its `on` key. A machine that declares `reads` gets a typed `helpers.reads` map (keyed by machine name, selectors preserved) in its actions, guards, **and selectors** — reads-aware selectors project cross-machine verdicts as display state, and bindings on the reading machine re-diff when a read machine changes. Declaring `reads` server-pins the machine, since cross-machine reads can't resolve in the browser.

**`peers` is the new name for `reads`** (3.1). `peers: [...]` on `defineMachine` and `helpers.peers` in actions, guards and selectors are the same list and the same map as `reads: [...]` and `helpers.reads`, which keep working through 3.x, are marked `@deprecated`, and are removed in 4.0. Every helpers object carries the map under both keys, so a machine can move one use at a time. Declaring both `peers` and `reads` on one machine throws at definition. A test stub passed to `createActor`'s `resolveHelpers` may use either key; a helpers object built by hand and typed as `ActionHelpers` needs both. `MachineDef` and `describeMachine()` carry `peers` beside `reads`. `persist: true` on a session machine is an error; sessions always persist through the session `Store`.

**Snapshots are bound to the machine's code.** Every persisted snapshot is stamped with a hash of the machine's code (the file plus every module it reaches, tree-shaken), and a snapshot whose hash no longer matches the running machine is discarded at hydration — the machine starts fresh. Machine state is working state, not persistence; see [What survives a deploy](/guides/persistence/#what-survives-a-deploy) for the rule, what moves the hash, and the reload-on-entry idiom for durable facts.

Each entry in an `on` map is a transition (or an ordered array of guarded candidates — first passing `when` wins):

```ts
{
  to?: S                        // target state; omit for a self-transition
  when?: (ctx, ev, helpers) => boolean   // helpers also has refuse(code, detail?)
  do?: (ctx, ev, helpers) => void   // mutates a draft; the engine owns clone + commit
  emit?: string | string[]      // declared emits fired after the action commits
  effect?: (ctx, ev, meta) => Promise<Events | null>
}
```

A bare function is sugar for `{ do: fn }`.

### Refusing with a reason

```ts
interface GuardHelpers extends ActionHelpers {
  refuse(code: string, detail?: { message?: string; issues?: RefusalIssue[] }): false
}

interface Refusal {
  code: string                  // the machine's own vocabulary: 'duplicate', 'full'
  message?: string              // a sentence for a person
  issues?: RefusalIssue[]       // per-field problems
}

interface RefusalIssue {
  path: ReadonlyArray<string | number>  // ['email'], ['guests', 2, 'name']; [] = the whole event
  message: string
}
```

A guard that should tell the sender why it said no calls `refuse` from its helpers and returns what it returns, which is always `false`:

```ts
REGISTER: {
  when: (ctx, ev, { refuse }) => {
    if (ctx.attendees.some((a) => a.email === ev.email))
      return refuse('duplicate', {
        issues: [{ path: ['email'], message: 'That email is already on the roster.' }],
      })
    if (ctx.seatsTaken + ev.seats > ctx.capacity)
      return refuse('full', { message: 'Not enough seats are left for a party that size.' })
    return true
  },
  do: (ctx, ev) => { /* … */ },
}
```

Because `refuse` returns `false`, guards still combine as booleans: `(a || refuse('a')) && (b || refuse('b'))` refuses with the code of the first check that failed. The reason is reported on the result of `actor.send` (see below) and is never written to the machine: nothing about it is in the snapshot, and the next event starts with no reason recorded.

- The first `refuse` call during one `send` is the one reported. Later calls in the same `send` still return `false` and record nothing.
- With an array of candidates, a reason is reported only when every candidate refused. A candidate whose guard passes commits the event and drops whatever an earlier one recorded, and so does a guard that calls `refuse` and then returns `true`.
- An event the current state does not handle, and a guard that returns `false` without calling `refuse`, are refused with no reason. The framework adds no codes of its own.
- `refuse` is only on the helpers handed to guards. Actions get `ActionHelpers` as before. A guard written against `ActionHelpers` still type-checks.

`'invalid'` is the conventional code for "the payload is wrong, see `issues`". A reason is read by whoever sent the event, so it is as public as the page: do not put another session's data in a message.

## createActor

```ts
function createActor(def: MachineDef, opts?: CreateActorOptions): Actor

interface CreateActorOptions {
  snapshot?: Snapshot           // restore from persisted state or a client seed
  resolveHelpers?: () => { peers } | { reads }  // host-provided peers resolver; either key
  onEffect?: (invocation: EffectInvocation) => void  // host effect scheduler
}

interface Actor<C, E> {
  start(): Actor<C, E>
  stop(): void
  send(event: E): SendResult
  seed(partial: Partial<C>): void   // merge into context before start(); no-op after
  getSnapshot(): Snapshot<C>
  getPersistedSnapshot(): Snapshot<C>
  subscribe(listener: (snapshot: Snapshot<C>) => void): { unsubscribe(): void }
  on(emitName: string, listener: (event) => void): () => void
}

interface SendResult {
  committed: boolean            // a transition matched and fired
  refusal?: Refusal             // only with committed: false, and only when a guard called refuse
}
```

Instantiates a running machine. The two injection points are what keep the engine isomorphic: the server wires `resolveHelpers` to the active dispatch context and `onEffect` to its post-commit queue; the client omits both, so effects run locally on a microtask and a `reads` dereference throws with a clear error. You call this directly in unit tests; the framework calls it everywhere else. `send` returns whether a transition fired and, when none did and a guard called `refuse`, the reason.

## Effects

```ts
type Effect = (ctx: C, ev: E, meta: EffectMeta) => Promise<Events | null>

interface EffectMeta {
  effectId: string
  signal?: AbortSignal          // aborts on state exit — entry effects only
}

interface EffectInvocation {
  machineName: string
  effectId: string
  kind: 'entry' | 'transition'
  stateKey?: string             // owning state — set for entry effects
  run: (signal?: AbortSignal) => Promise<EventObject | null>
}
```

An effect is async I/O declared on a transition and run by the **host** after the transition commits — the engine itself never performs I/O. It receives `structuredClone` snapshots of context and event taken at commit time (never live state), plus `meta.effectId`, unique per invocation — thread it to external calls as an idempotency key and use it for log correlation. Return the completion event to dispatch, or `null` for fire-and-forget.

Two rules to know:

- **Annotate the return type**: `effect: async (ctx, ev, meta): Promise<Events | null> => …`. TypeScript defers context-sensitive arrows during `defineMachine`'s inference, so an unannotated effect fails to typecheck; the annotation restores full checking of the completion event against your event union.
- **Effects are infallible by construction**: catch inside and return your declared failure event. A throw is the runtime backstop — logged and dropped, never a crash.

### meta.session

```ts
interface EffectMeta {
  effectId: string
  signal?: AbortSignal
  session?: { id: string; claims<T = unknown>(): T | undefined }
}
```

For **session** machines the server host sets `meta.session` on every effect — the session id and its app-defined claims as of the moment the effect started (the same claims middleware reads with `stator(c).claims()`). It is what lets an entry effect reload a durable fact by identity on a fresh start or after a [snapshot reset](/guides/persistence/#what-survives-a-deploy), with no client round trip. App machines have no session and client islands run no host, so it is `undefined` there.

### seed

```ts
seed?: (session: { id: string; claims<T>(): T | undefined }) =>
  { state?: S; context?: Partial<C> } | undefined
```

**Session machines only.** Where the machine starts when it has no usable snapshot — a new session, or a [snapshot reset](/guides/persistence/#what-survives-a-deploy) — given the session's claims (the same claims middleware reads with `stator(c).claims()`). The host applies it synchronously before the first render: `context` is merged over the defaults, and `state`, if given, replaces `initial` and is entered for real (its entry effect fires, its `after` timers arm). Return `undefined` to start at `initial` with the defaults. Never consulted when a snapshot hydrates. Runs under a guard's rules — synchronous and quick. Declaring it on an app machine is an error. The sign-in idiom is in the [persistence guide](/guides/persistence/#what-survives-a-deploy).

## Entry effects

```ts
type EntryEffect = (ctx: C, meta: EffectMeta) => Promise<Events | null>

states: {
  loading: {
    entry: async (ctx, meta): Promise<Events | null> => {
      const data = await fetchForecast(ctx.location, { signal: meta.signal })
      return { type: 'LOADED', data }
    },
    on: { LOADED: { to: 'ready', do: (ctx, ev) => { ctx.data = ev.data } } },
  },
}
```

A state's `entry` is async I/O the host schedules when the state is **entered** — a fresh start at the initial state, or a value-changing transition (never on a bare snapshot restore). Same host-scheduled, off-lock pipeline as a transition effect, minus the event argument (a state entry has no triggering event).

The role split matters: entry effects are the **load** role and transition effects are the **command** role. The host may *re-invoke* an entry effect whose completion never settled (a process died mid-flight) and aborts `meta.signal` when the state is exited — so write entry effects as re-runnable reads, and keep non-idempotent external writes (charges, sends) in transition effects, which are at-most-once and never aborted. See the [effects guide](/guides/effects/).

## State timeouts: after

```ts
interface AfterEntry {
  delay: number | ((ctx: C) => number)
  send: Events
}

states: {
  shown: { after: [{ delay: 5_000, send: { type: 'DISMISS' } }] },
}
```

Each `after` entry dispatches `send` after `delay` ms in the state — armed on entry, cancelled on exit. Host-scheduled and in-memory: a restart drops armed timers (a host restoring a snapshot re-arms with elapsed credit via `enteredAt`). Durable schedules are deferred work.

## describeMachine

```ts
function describeMachine(def: AnyMachineDef): MachineDescription
```

Serializes a machine def to plain JSON-able data — the def *is* the statechart, and this walks it: states, per-event transition candidates (`to`, guard/action/effect presence, emit names), entry effects and `after` timers (`delay` reported as its number, or `'dynamic'` for a context-dependent one), machine-level fallback handlers, the handled-event list, `serverOnly`, emit and selector names, `reads`/`subscribes` (as machine names), and the initial context. Closures stay opaque — a guard or effect reports presence, never its body. Pure and side-effect free; it never invokes app code.

This is the introspection substrate: the dev inspector's [Machines tab](/reference/dev-and-build/#createdevapp) is built on it, and it's the walk to reach for when building your own tooling over a machine's shape. `MachineDescription`, `StateDescription`, and `TransitionDescription` are exported alongside it.

## Lower-level exports

Type-level plumbing, exported for tooling and advanced typing:

- `EventObject` — the base event shape (`{ type: string }`).
- `EventOf<Def>` — a machine's event union; what `dispatch(Machine, event)` checks against.
- `InstanceOf<Def>` — a machine's instance shape (each selector as a typed property).
- `PeersMap<Peers>` — the typed `helpers.peers` map built from a `peers` tuple. `ReadsMap` is its deprecated old name.
- `Snapshot<C>` — `{ value: string[]; context: C; enteredAt?: number; pendingEntry?: { effectId: string } }`; serializes to the Store and seeds a client island on upgrade. `enteredAt` lets a restoring host re-arm `after` timers with elapsed credit; `pendingEntry` marks an entry effect whose completion never settled, so the host re-invokes it.
- `Action`, `Guard`, `ActionHelpers`, `GuardHelpers` — the function shapes transitions are built from; `GuardHelpers` adds `refuse`.
- `Refusal`, `RefusalIssue`, `SendResult` — what `actor.send` returns, and the reason a guard gave (see [Refusing with a reason](#refusing-with-a-reason)).
- `EntryEffect`, `AfterEntry` — the state-entry effect and timeout-entry shapes.
- `Transition`, `TransitionConfig`, `StateNode` — the transition-graph node types.
- `EmitDeclaration`, `EmitsConfig` — normalized emit declarations.
- `SubscribeEntry` — a cross-machine subscription entry.
- `Capabilities` — `{ serverPinned, reasons }`; why a machine can't run client-side.
- `Lifecycle` — `'app' | 'session'`.
- `MachineDef`, `AnyMachineDef`, `AnyActor` — the def/actor types and their heterogeneous-collection "top types".
- `isStatorMachine` — brand guard for a machine def.
