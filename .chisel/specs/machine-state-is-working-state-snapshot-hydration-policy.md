---
title: 'Machine state is working state: snapshot hydration policy'
status: draft
created: 2026-08-22
updated: 2026-08-22
area: engine
---

## What and Why

A machine's persisted snapshot — `{ value, context, enteredAt, pendingEntry }` (`engine/types.ts:206`) — carries no record of the code it was taken from, and hydration trusts it completely: `createActor` copies `value` and `context` in verbatim (`engine/actor.ts:113-123`) with no check that the state still exists in the chart or that `context` matches what the selectors now expect. After a def change, a stale snapshot produces one of: a harmlessly stale value (a removed default city still showing), a selector reading `undefined` (a new context key), state that a rewritten guard would never have allowed, or — the dangerous one — an actor parked in a state the chart no longer has, where every `on` lookup misses and **every event is silently a no-op**. A dead session, logged nowhere.

This surfaced in dev (a machine edit that didn't "take" because the session already had a snapshot — and the dev reference promises that a machine edit resets the store, which is true only when no session store is configured), but dev is just where it's visible first. A production deploy that renames a state hydrates yesterday's Redis snapshots (weather's TTL is 24 h) and dead-ends real users.

Two decisions answer it. **What Stator guarantees about machine state in storage:** machines are working state, not persistence. **When a snapshot may be hydrated:** only by the code that wrote it — *any change to the code that can execute as part of a machine invalidates that machine's sessions, at the next hydration, identically in dev and prod.* The rest of this spec is the mechanism that makes the second decision precise and cheap.

## Success Criteria

- Every persisted snapshot carries the code hash of the machine that wrote it; hydration compares it to the running machine's hash and, on mismatch or absence, starts the machine fresh (initial state, default context, entry effects and `after` timers armed as for a new session), throws nothing, and logs one rate-limited line naming the machine and both hashes.
- The hash changes when a guard, action, effect, selector, state, event key, or context default changes — in the machine file **or in any module it reaches** — and does not change for a comment, whitespace, or an export the machine never uses. Each of those is a unit test over the hash function alone.
- The hash is computed by the same function at the same point (machine discovery) in `stator start`, the Vite-backed dev server, and the native dev server; there is no environment branch on the hydrate path and no artifact the runtime depends on.
- App machines (`lifecycle: 'app'`, `persist: true`) follow the same rule at boot, with the same log line.
- A snapshot persisted before this ships (no hash field) hydrates as a mismatch — one reset per machine per session on upgrade, stated in the changelog.
- `stator build` writes each machine's hash into `stator-manifest.json` as a receipt, and reports which machines changed against the previous manifest when one exists. `stator start` never reads it.
- Docs state the guarantee and the invalidation rule where persistence and the dev server are documented; the false "resets the store" sentence is gone; `persist: true` is described as surviving restarts *while the machine's code is unchanged*.

## Constraints

- **Backward compatible with stored snapshots.** The only change to the persisted shape is an optional `code: string`. Absent ⇒ mismatch ⇒ reset.
- **Store-agnostic.** The policy lives at hydrate (`session-runtime.ts:67` and `:115`, plus the app-machine boot path), never in a `Store`/`AppStore` adapter.
- **No environment branching, and no clearing.** Dev behaviour is prod behaviour plus a log line. The dev server never clears a store — a configured store may be shared (a team Redis, a homelab instance) and a file save must never be destructive against it. Invalidation happens at hydrate, one session at a time.
- **Raw-TS packaging is untouched.** What runs in `dist/` stays plain inspectable TS with shared module instances; the per-machine bundle exists in memory only long enough to be hashed.
- **Evidence before primitives.** No migration hook ships (see *Path forward*).

## Approach

### The guarantee

A session's machines are **working state with a TTL**. Stator keeps them across requests, across live connections, and across deploys that leave their code untouched, and discards them when the session expires (`sessions.ttlSeconds`, default 24 h), when a server with no configured store restarts, or when the machine's code has changed. App machines with `persist: true` survive restarts on the same terms.

Anything whose loss is an incident is a **durable fact**, and durable facts go to the application's own persistence through an effect — `ADD` writes the cart row, `REGISTER` writes the registration — and are read back in by an entry effect when the machine (re)starts. A snapshot reset is then a cache miss, not data loss; deploys, restarts, TTL expiry, a Redis flush and a second replica all become the same non-event. This is the position HTTP sessions and Phoenix LiveView take and the one XState documents for its persisted snapshots; it is not the Temporal/OTP position, where persisted state *is* the product and per-unit migrations are the price. Under this position the reload-on-entry idiom is not advice but the documented requirement for state that must outlive a deploy: a retailer persists the cart, full stop.

### The principle, and why it is decidable

*Sessions never outlive the code that made them.* This replaces a semantic judgement the framework cannot make ("is old state still acceptable under the new rule?") with a syntactic one it can: did the code change? Whether a change *alters behaviour* is program equivalence and undecidable; whether the machine's **executable closure** changed is a graph walk and a hash. The principle accepts the false positives (a behaviour-preserving refactor resets sessions) as the price of never having a false negative — and the only remaining design choice is how tightly "the code" is drawn, which is a dial:

| hash over… | resets on… | misses… |
|---|---|---|
| every file in the import closure, raw | a comment, whitespace, an unused export in a shared `lib` file | nothing reachable |
| the closure after tree-shaking + minify — **chosen** | only code that can actually execute for this machine | nothing reachable; comments and dead exports don't count |
| semantic equivalence | only real behaviour changes | not on offer |

### The hash

`machineCodeHash(file, { root, machinesDir }) → string`, a pure function:

- `esbuild.build({ entryPoints: [file], bundle: true, minify: true, write: false, metafile: true, format: 'esm' })` with an `onResolve` plugin that marks as **external** anything not under `root` (the framework, `node_modules`) and any **sibling machine** under `machinesDir` other than the entry. Externalizing siblings means a machine's hash is its *own* reachable code — a `WeatherMachine` edit does not reset `ForecastCache` sessions, whose logic did not change. (Inlining siblings would merely over-reset, which the principle permits; externalizing is the tighter reading.)
- `sha256(outputFiles[0].contents + '\0' + statorVersion + '\0' + esbuildVersion)`. The framework and esbuild versions are inputs on purpose: an engine upgrade or a transform-engine upgrade is a change to what executes. Each resets sessions once and the changelog says so.
- Deterministic: esbuild's output is a pure function of its inputs and version, and the version is in the hash.
- **The bundle is a measurement, not an artifact.** It is never written and never run. Running per-machine bundles would duplicate imported defs (breaking `reads:`/`subscribes:`/typed `dispatch` identity — the dual-instance class on purpose) and module singletons (a `lib/db.ts` connection per machine), and would put one opaque file in an otherwise raw-TS `dist/`. `write: false` sidesteps all of it.

Unit tests over the function: same file twice → equal; comment/whitespace edit → equal; guard body edit → differs; a context default edit → differs; a *used* export in `lib/` edited → differs; an *unused* export in `lib/` edited → equal; sibling machine edited → equal.

What no hash sees, and what the principle does not cover: environment variables, database contents, dynamic `import()` with a computed specifier, code built from strings. Those are not code, and a change to them does not reset sessions.

### Where the hash is computed: discovery, at boot, in every environment

`discoverMachines(dir, loader)` is already the one place each runtime imports every machine — `stator start` over `dist/machines/`, both dev servers over the source tree. It computes the hash per file there and attaches it to the def under a global symbol (`Symbol.for('stator.code-hash')`, the `BOOT_BRAND` trick, so it survives the old dev path's dual instance). The def carries its own fingerprint; whoever has the def at hydrate has the hash. No registry, no plumbing through `createApp`, nothing to keep in sync.

Why at boot rather than from a build artifact: `stator start` already runs esbuild on every module at import (the CLI loader) and for the inspector; `dist/` is source, so the inputs are exactly the files that execute; one function at one call site is the dev==prod guarantee; and a manifest as the source of truth introduces a second truth with silent failure modes (missing for programmatic `createApp` users, stale after a hand edit, unwired) that each degrade to "reset always" or "reset never." Cost is milliseconds per machine, once, before `listen`; measure on `weather` (5 machines) during implementation.

**If the TS loader ever goes native** (Node's type stripping instead of esbuild at import), esbuild moves to build time and the manifest becomes the source of truth rather than a receipt, with `stator start` reading it and a missing entry treated as a mismatch. Same function, same closure, different moment. The direction is unchanged; only the call site moves. Recorded here so the loader decision (`toolchain-adapter-seam-and-the-vite-exit`) and this one stay consistent: today the loader is kept for the TS surface it gives app code (full TypeScript, no erasable-syntax rules to bubble up), which makes esbuild a deliberate runtime dependency with four jobs — prod loader, dev loader, inspector bundle, machine hash.

`stator build` calls the same function and writes `machines: { [name]: hash }` into `stator-manifest.json` purely as a receipt, diffing against the previous manifest when one is present to print *"this deploy resets sessions of: CartMachine, SettingsMachine"* — the deploy-awareness a retailer wants. `stator start` ignores it; a missing manifest changes nothing.

### Hydration

```ts
// session-runtime.ts hydrate / rehydrate, and the app-machine boot path
const expected = codeHashOf(def)
const usable = persisted !== null && persisted.code === expected
if (persisted !== null && !usable) logReset(def.name, persisted.code, expected)
createActor(def, { snapshot: usable ? persisted : undefined, ... })
```

Reset means: the actor starts at `def.initial` with the def's default context, exactly as a new session would, so entry effects and `after` timers arm normally. The stale snapshot is overwritten on the next commit, not deleted eagerly. Snapshots are stamped with `code` where they are written today (`session-runtime.ts:270` and the app-machine persist path). One `warn` line per reset, rate-limited to one per machine per process with a running count, so a deploy across a large store does not flood.

### Consequences, stated plainly

- **A deploy that touches a machine resets that machine's sessions.** Mid-flow users land on the flow's initial state after the build-id reload. Acceptable only because durable facts live in the app's store — hence the reload-on-entry requirement above.
- **`persist: true` is "survives restarts while the code is unchanged."** A persisted tally or counter that must survive a code change belongs in a store, same as a cart. This has teeth against the current positioning; say it in the persistence guide rather than softening the rule for app machines.
- **Framework and esbuild upgrades reset everything once.** Rare; changelog.
- **Rule drift cannot occur.** No session runs under guards it was not created under, so the "guards at the point of use" advice is no longer load-bearing for correctness — it remains good machine design.

### Dev

Both dev servers hydrate with the same function, so a saved edit resets affected sessions on their next request. The native server's affected set can come from the hash's own `metafile.inputs` — the exact resolved graph per machine, including TS path resolution — which also fixes the current quirk where the `MachineStore` is rebuilt only on an edit *under `machines/`*: rebuild it when any file in any machine's input set changed. On a rebuild, log which machines' hashes changed. A restart still wipes an in-memory store. Nothing ever clears a store on a file save.

### Path forward (reserved, not built)

Under "sessions never outlive their code," a migration hook is out of character, and the retailer test says the durable layer is where continuity belongs. If an app ever proves reload-on-entry insufficient — most plausibly a `persist: true` app machine whose reset is an incident — the addition is an explicit `version` on the def reintroduced as a *stable* key (the hash is not monotonic, so it cannot key a migration) with `migrate(snapshot, fromVersion)` consulted before the reset rule. That changes neither the persisted format (the field is additive) nor the hydrate contract. Until such an app is logged, the hook is speculation.

## Alternatives Considered

- **Structural check + shallow merge + explicit `version` (this spec's first landing).** Reset only on a missing state or a version bump; merge new context keys; treat guard/action changes as rule drift handled by guards at the point of use. Superseded: it asked the author to judge, per change, whether old state is acceptable, and left sessions running under rules they were not created under. The principle removes the judgement and the hole at once, and is simpler to explain.
- **Fingerprint the def's shape** (states, event keys, context keys, defaults). Rejected: misses every change inside a guard or action body, which is where behaviour lives.
- **Hash the raw import closure, or the module source.** Rejected in favour of the tree-shaken, minified bundle: same reachability, fewer false positives (comments, whitespace, dead exports).
- **Run the per-machine bundles as the build output.** Rejected: duplicates imported defs and module singletons, breaks identity-based wiring, and puts an opaque artifact in a raw-TS `dist/`. Hashing the bundle gives the fingerprint without any of it.
- **Build-time manifest as the runtime's source of truth.** Rejected today (two truths, silent failure modes); becomes the right answer only if the TS loader goes native (above).
- **Clear the store on dev reload, per machine.** Rejected: dev-only, destructive against a store the dev server does not own, keyed to a file edit rather than to the code a snapshot came from.
- **Per-machine migrations now.** Deferred; slot reserved.

## Open Questions

- **The reload key.** `EffectMeta` is `{ effectId, signal }` — an entry effect has no session identity, so after a reset it cannot know which durable cart to load unless the key lives outside the snapshot. Candidates: expose `sessionId` (and claims) on `EffectMeta` for session machines; or a `serverOnly` `RESUME { userId }` dispatched from middleware on the first request. Decide with the first real consumer (the store app's cart).
- **Hash cost at boot.** Expected milliseconds per machine; confirm on `weather` and on the largest example before flipping it on.
- **Externalizing siblings vs inlining.** Externalized here (tighter); revisit if a real app shows a subscriber that should reset when its source machine changes.
- **App-machine reset acknowledgement.** A shared app machine resetting on deploy is more visible than a session reset; same rule, but the log line should make the trigger obvious.
- **Snapshot `format`.** Whether to add an engine-level `format` field alongside `code` so the snapshot shape itself can evolve (hierarchy in `value`). Cheap to add now; zero cost to defer since absent ⇒ current format.
- **`stator check`.** Whether the build-time diff should also run in `check`, so a developer sees "this change resets CartMachine sessions" before building.

## Implementation Notes

- Engine: `code?: string` on `Snapshot`; `getPersistedSnapshot()` unchanged (the host stamps). `createActor` accepts the snapshot as today — the policy is the host's, applied before the actor is built.
- Server: `machineCodeHash()` in `server/machine-hash.ts` (esbuild `write: false`, externals plugin, versions appended); `discoverMachines` computes and attaches it under `Symbol.for('stator.code-hash')`; `reconcileSnapshot(def, persisted) → { snapshot?: Snapshot; reset?: { from?: string; to: string } }` called from `SessionRuntime.hydrate` (`session-runtime.ts:67`), `SessionRuntime.rehydrate` (`:115`) and the app-machine boot path; stamping at `session-runtime.ts:270` and the app persist path; rate-limited reset logger.
- Build: `buildApp` writes `manifest.machines`; `stator build` prints the diff against the previous manifest when present.
- Dev: native server uses `metafile.inputs` for machines' affected set and rebuilds the store when any machine's inputs changed; both dev servers log changed machines on rebuild.
- Tests: the hash-function table above; reconcile unit tests (match, mismatch, absent, app path); one integration test per hydrate path; a dev-server test that edits a `lib/` file a machine imports and asserts the session reset + log line; a build test for the manifest receipt.
- Docs: `guides/persistence` gains the guarantee, the invalidation rule and the reload-on-entry idiom; `reference/machine` documents the rule and the `persist: true` wording; `reference/dev-and-build.md:40` loses "only a machine edit resets it"; README known-limitations gets one line; changelog notes the one-time reset on upgrade.
- Related: [[store-adapter-with-per-session-ttl]] (the TTL this leans on), [[app-machine-state-persistence]] (the `persist: true` path), [[engine-effects-async-i-o-from-machine-transitions]] and [[entry-effects-state-entry-async]] (the durable-facts channel), [[session-identity-and-auth-primitives]] (claims already live outside snapshots — the precedent for "durable-ish state is not machine state"), [[toolchain-adapter-seam-and-the-vite-exit]] (esbuild as a deliberate runtime dependency; the native-TS contingency).
