---
title: 'Machine state is working state: snapshot hydration policy'
status: draft
created: 2026-08-22
updated: 2026-08-22
area: engine
---

## What and Why

A machine's persisted snapshot — `{ value, context, enteredAt, pendingEntry }` (`engine/types.ts:206`) — carries no record of the definition it was taken from, and hydration trusts it completely: `createActor` copies `value` and `context` in verbatim (`engine/actor.ts:113-123`) with no check that the state still exists in the chart or that `context` has the keys the selectors now expect. After a def change, a stale snapshot produces one of: a harmlessly stale default (a removed default city still showing), a selector reading `undefined` (a new context key), or — the dangerous one — an actor parked in a state the chart no longer has, where every `on` lookup misses and **every event is silently a no-op**. A dead session, logged nowhere.

This surfaced in dev (a machine edit that didn't "take" because the session already had a snapshot — see the dev-reference sentence promising that a machine edit resets the store, which is true only when no session store is configured), but dev is just where it's visible first. A production deploy that renames a state hydrates yesterday's Redis snapshots (weather's TTL is 24 h) and dead-ends real users.

The question underneath is what Stator *guarantees* about machine state in storage. This spec answers it: **machines are working state, not persistence.** That single position makes the hydration policy small, keeps migrations out until evidence demands them, and tells users where durable facts belong.

## Success Criteria

- A snapshot whose `value` names a state the def no longer has hydrates to the def's initial state (entry effect and `after` timers armed as for a fresh session), throws nothing, and logs one line naming the machine and the reason.
- A snapshot missing a context key the def now declares hydrates with that key filled from the def's default; keys the snapshot has win; keys the def no longer declares are ignored.
- A def whose `version` is higher than the snapshot's resets the snapshot; equal keeps it; a snapshot with no `version` field (every snapshot persisted before this spec) is treated as version 0, so existing stores hydrate exactly as today.
- App machines (`lifecycle: 'app'`, `persist: true`) follow the same rule at boot (`bootAppMachines`), with the same log line.
- Dev and prod run the identical policy — no environment check anywhere on the hydrate path.
- The `stator dev` rebuild log on a machine edit states what existing sessions will do, so the dev surprise that motivated this is explained at the moment it happens.
- Docs state the guarantee where persistence is documented and where the dev server is documented; the false "resets the store" sentence is gone.

## Constraints

- **Backward compatible with stored snapshots.** No re-encoding, no store migration: the only change to the persisted shape is an optional `version` number. Absent ⇒ 0.
- **Store-agnostic.** The policy lives at hydrate (`session-runtime.ts:67` and `:115`, plus the app-machine boot path), not in any `Store`/`AppStore` adapter, so `InMemoryStore`, `RedisStore`, `CachedStore` and anything user-written get it unchanged.
- **No environment branching.** Dev behaviour is prod behaviour plus a log line. The dev server never clears a store — a configured store may be shared (a team Redis, a homelab instance), and a file save must never be destructive against it.
- **Evidence before primitives.** No `migrate` hook ships; the design reserves the slot so adding one later is additive (see *Path forward*).

## Approach

### The guarantee

A session's machines are **working state with a TTL**. Stator keeps them across requests, across live connections, and across deploys *when it safely can*, and discards them when the session expires (`sessions.ttlSeconds`, default 24 h), when the server has no store configured and restarts, or when the machine definition has changed in a way the snapshot can't be trusted under (below). App machines with `persist: true` survive restarts but follow the same def-change rule.

Anything whose loss is an incident is a **durable fact**, and durable facts go to the application's own persistence through an effect — `ADD` writes the cart row, `REGISTER` writes the registration — and are read back in when the machine (re)starts. A snapshot reset is then a cache miss, not data loss; deploys, restarts, TTL expiry, a Redis flush and a second replica all become the same non-event. This is the position HTTP sessions and Phoenix LiveView take, and the one XState documents for its persisted snapshots; it is not the Temporal/OTP position, where persisted state *is* the product and per-unit migrations are the price.

### Hydration policy

At hydrate, for each machine with a persisted snapshot:

| snapshot vs def | outcome |
|---|---|
| `snapshot.value[0]` is not a key of `def.states` | **reset** — hydrate as a fresh session, log |
| `def.version > (snapshot.version ?? 0)` | **reset**, log |
| def declares a context key the snapshot lacks | **merge** — `context = { ...def.context, ...snapshot.context }` (shallow, snapshot wins) |
| snapshot has a key the def no longer declares | ignored (extra data is harmless) |
| new/removed events, changed guards, actions, effects, `after` delays | nothing — rule drift, see below |

"Reset" means: the actor starts at `def.initial` with the def's default context, exactly as a new session would, so entry effects and `after` timers arm normally. The discarded snapshot is overwritten on the next commit, not deleted eagerly.

The shallow merge is the same default redux-persist ships (`autoMergeLevel1`). It costs nothing to author and makes every additive evolution — a new event, a new optional field — a non-event for existing sessions. Only the two structurally fatal cases reset: a state that no longer exists, and an explicit version bump.

### `version` — the author's lever

```ts
defineMachine({
  name: 'CartMachine',
  version: 2, // bump when existing state must not survive a rule change
  ...
})
```

Optional, integer, default 0, written into every snapshot the machine persists. It is the manual answer to the class no hash can detect: **semantic drift** — a `price` that was cents and is now dollars under the same key, a rule change under which old state is genuinely invalid. A guard is a predicate over future events, not over a snapshot, so "this context would no longer pass the new guard" leaves no structural trace; deciding whether old state is acceptable under a new rule is a product judgement, and the integer is how the author makes it.

Two things are deliberately *not* in the trigger set:

- **Context defaults.** If changing `DEFAULT_PLACES` reset sessions, a deploy that tweaks a default would wipe every user's chosen cities — a default is what you get when you haven't chosen. So the dev sequence that surfaced this (edit a default, reuse a seeded session, still see the old value) stays as it is, and it is correct prod behaviour; the dev log line is the explanation.
- **Function bodies / source text.** Resetting on any source change would make every deploy that touches a comment in `cart.ts` empty every cart mid-checkout — a worse bug than the one it prevents, and it would make people afraid to edit machine files.

### Rule drift is guarded at the point of use

The stale-but-running case (five items in a cart whose `ADD` guard now says three) is the normal condition of every stateful system the day after a rule changes, and Stator's answer is the machine-self-containment principle: invariants that matter are **guards on the consequential transition**. If checkout must not proceed with more than three items, that is `when` on `CHECKOUT`, not only on `ADD`. A guard at the point of use holds for stale context by construction; a hash that tries to predict invariant violations is strictly weaker than a guard that checks them. Three layers, each cheap: the hydrate check keeps the engine sane, `version` lets the author force a reset, guards make old data safe.

### Durable facts: the reload-on-entry idiom

```ts
export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  context: { cartId: null as string | null, items: [] as Item[] },
  initial: 'loading',
  states: {
    loading: {
      // Runs for a new session AND after a reset: the working copy is rebuilt
      // from the durable cart, so a snapshot reset is a cache miss.
      entry: async (ctx, meta): Promise<CartEvents> => {
        const cart = await loadCart(/* key — see Open Questions */)
        return cart ? { type: 'LOADED', cart } : { type: 'EMPTY' }
      },
      on: { LOADED: { to: 'ready', do: (ctx, ev) => { ctx.items = ev.cart.items } }, EMPTY: 'ready' },
    },
    ready: {
      on: {
        ADD: {
          do: (ctx, ev) => { ctx.items.push(ev.item) },
          effect: async (ctx) => { await saveCart(ctx.cartId, ctx.items); return null },
        },
      },
    },
  },
})
```

Entry effects (shipped — see [[entry-effects-state-entry-async]]) already re-invoke on hydration, so this is idiom, not new machinery. What it needs that the engine does not yet give it is a **stable key** — after a reset, context is defaults, so "which cart" must come from outside the snapshot. See Open Questions.

### Logging

One line per reset, with the machine name, the session (or `app`), and the reason (`state "checking-out" no longer exists` / `version 1 → 2`). `warn` level — a deploy that resets sessions should be visible — rate-limited to one line per machine per process with a running count, so a deploy across a large store doesn't flood.

### Dev

The dev servers keep doing what they do (a configured store is reused across rebuilds; the no-store fallback is recreated). On a machine-file rebuild, both log: `CartMachine changed — existing sessions keep their snapshots unless a state was removed or \`version\` was bumped`. A restart still wipes an in-memory store, which remains the honest "give me fresh state" in dev. Nothing clears a store on a file save.

### Path forward (reserved, not built)

`migrate?: (snapshot: { version: number; value: string[]; context: unknown }) => Snapshot | null` on the def, keyed by `version`, consulted before the reset rule. Because `version` is already in the snapshot, adding it later changes neither the persisted format nor the hydrate contract. Promotion trigger: a real app where reload-on-entry is demonstrably too heavy for the state in question — most likely an app machine with `persist: true` whose reset is an incident. Until one is logged, the hook is speculation, and shipping it would tell users machines *are* persistence, undercutting the layer that actually protects them.

## Alternatives Considered

- **Clear the (in-memory or Redis) store on dev reload, per machine.** Rejected: dev-only, so the identical hazard reaches prod unguarded; destructive against a store the dev server doesn't own; keyed to the wrong event (a file edit) rather than the truth (the def the snapshot came from) — a Redis that outlived a restart has stale snapshots with no edit to trigger anything.
- **Fingerprint the def's shape (states, event keys, context keys, defaults) and reset on mismatch.** The first sketch. Rejected as the trigger because additive changes — the common evolution — would reset needlessly, and because defaults in the hash would make a default tweak wipe user choices in prod. Checking state existence directly plus `version` covers the fatal case; the shallow merge covers the additive case.
- **Hash the machine module's source.** Rejected: every deploy touching the file resets every session.
- **Per-machine `migrate` now.** Deferred, slot reserved (above).
- **Validate context shape strictly (reset on any key mismatch).** Rejected in favour of merge: strictness buys nothing a default can't, and resets on every added field.

## Open Questions

- **The reload key.** `EffectMeta` is `{ effectId, signal }` — an entry effect has no session identity, so after a reset it can't know which durable cart to load unless the key lives outside the snapshot. Candidates: expose `sessionId` (and claims) on `EffectMeta` for session machines; or a `serverOnly` `RESUME { userId }` dispatched from middleware on the first request. Decide with the first real consumer (the store app's cart is the obvious one) rather than here.
- **`stator check` lint.** A removed/renamed state is detectable at check time against the previous def (or a recorded fingerprint); a lint saying *"state X removed — sessions in X will reset"* is the compile-time half of this guard. Worth it once the runtime half exists; probably cheap.
- **App-machine reset acknowledgement.** A shared app machine resetting on deploy is more visible than a session reset. Same rule, but consider whether `persist: true` machines should require `version` to be explicit.
- **Snapshot `format`.** Whether to add an engine-level `format` field now (distinct from the def's `version`) so the snapshot shape itself can evolve (hierarchy in `value`). Cheap to add alongside; zero cost to defer since absent ⇒ current format.

## Implementation Notes

- Engine: `version?: number` on `MachineDef`; `version?: number` on `Snapshot`; `getPersistedSnapshot()` writes it. `createActor` accepts the snapshot as today — the policy is the host's, applied before the actor is built.
- Host: one function, `reconcileSnapshot(def, snapshot) → { snapshot, reset?: reason }`, called from `SessionRuntime.hydrate` (`session-runtime.ts:67`), `SessionRuntime.rehydrate` (`:115`), and the app-machine boot path. Unit tests over the table above; an integration test per path (session, rehydrate, app boot); a dev-server test that edits a machine and asserts the log line.
- Docs: `guides/persistence` gains the guarantee and the reload-on-entry idiom; `reference/machine` documents `version`; `reference/dev-and-build.md:40` loses "only a machine edit resets it" in favour of the real rule; README known-limitations gets one line.
- Related: [[store-adapter-with-per-session-ttl]] (the TTL this leans on), [[app-machine-state-persistence]] (the `persist: true` path), [[engine-effects-async-i-o-from-machine-transitions]] and [[entry-effects-state-entry-async]] (the durable-facts channel), [[session-identity-and-auth-primitives]] (claims already live outside snapshots — the precedent for "durable-ish state is not machine state").
