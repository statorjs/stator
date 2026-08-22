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
- One hash function. `stator build` computes it for every machine, **fails the build** if any machine's closure cannot be bundled, and writes the hashes into `stator-manifest.json`; `stator start` consumes them from the manifest and treats a discovered machine with no entry as a boot error — never a silent always-reset; the dev servers compute the same function live, on boot and on each rebuild for the affected machines. No environment branch on the hydrate path.
- App machines (`lifecycle: 'app'`, `persist: true`) follow the same rule at boot, with the same log line.
- A snapshot persisted before this ships (no hash field) hydrates as a mismatch — one reset per machine per session on upgrade, stated in the changelog.
- `stator build` reports which machines' hashes changed against the previous manifest when one exists ("this deploy resets sessions of: …") and how long hashing took.
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

- `esbuild.build({ entryPoints, bundle: true, minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, write: false, metafile: true, format: 'esm' })` with an `onResolve` plugin that marks as **external** every bare specifier (the framework, `node_modules` — no app root needed), `.stator` files, and any **sibling machine** (a `.ts`/`.js` directly in `machinesDir`) other than the entry. Externalizing siblings means a machine's hash is its *own* reachable code — a `WeatherMachine` edit does not reset `ForecastCache` sessions, whose logic did not change. (Inlining siblings would merely over-reset, which the principle permits; externalizing is the tighter reading.) Two details found by the tests: **identifiers are not minified** — esbuild allocates minified names across the whole module set, so a dead export in an imported module shifted a name in the bundle and moved the hash for code that never runs; with source identifiers kept, the output is a function of the reachable code only (a local rename is a code change and resets, which the principle permits). And **externals keep their specifier in the bundle**, so siblings and templates are emitted under a stable `stator:<path relative to machinesDir>` id, never an absolute path — otherwise a machine importing a sibling would hash differently per checkout directory and every CI path change would reset its sessions.
- `sha256(outputFiles[0].contents + '\0' + statorVersion + '\0' + esbuildVersion)`. The framework and esbuild versions are inputs on purpose: an engine upgrade or a transform-engine upgrade is a change to what executes. Each resets sessions once and the changelog says so.
- Deterministic: esbuild's output is a pure function of its inputs and version, and the version is in the hash.
- **The bundle is a measurement, not an artifact.** It is never written and never run. Running per-machine bundles would duplicate imported defs (breaking `reads:`/`subscribes:`/typed `dispatch` identity — the dual-instance class on purpose) and module singletons (a `lib/db.ts` connection per machine), and would put one opaque file in an otherwise raw-TS `dist/`. `write: false` sidesteps all of it.

One nuance: exports of the machine file *itself* are its public surface (other modules may import `DEFAULT_PLACES` from it), so esbuild keeps them all — adding or changing an export on the machine file moves the hash even if nothing inside the machine uses it; only *imported* modules are tree-shaken. Unit tests over the function (`tests/machine-hash.test.ts`, landed 2026-08-22): same file twice → equal; comment/whitespace edit → equal; guard body edit → differs; a context default edit → differs; a *used* export in `lib/` edited → differs; an *unused* export in `lib/` edited → equal; sibling machine edited → equal; `inputs` lists the machine and its app modules, not siblings or packages; an unbundleable closure throws naming the missing import.

What no hash sees, and what the principle does not cover: environment variables, database contents, dynamic `import()` with a computed specifier, code built from strings. Those are not code, and a change to them does not reset sessions.

### Where the hash is computed: at build for production, live for development

One function, two moments:

- **`stator build`** hashes every machine in one esbuild invocation (all machine files as `entryPoints`, no `splitting`, so each output is still that machine's standalone bundle), writes `machines: { [file]: hash }` into `stator-manifest.json` (keyed by file relative to `machines/` — the build never executes a machine to learn its name; discovery at boot has both and logs names), and **fails the build** if any machine's closure cannot be bundled — a machine with an import esbuild can't resolve is an import problem, and CI is where it should surface, not a production boot after CI went green. The build also prints the diff against the previous manifest when one exists (*"this deploy resets sessions of: CartMachine, SettingsMachine"*) and how long hashing took.
- **`stator start`** reads the manifest (the same load that already supplies `buildId` and the island head) and attaches each hash to its def at discovery. A discovered machine with **no manifest entry is a boot error** — the one rule that keeps a build artifact from becoming a silent second truth: it can be missing, but it cannot be missing quietly. Production boot does no hashing at all, so boot cost is independent of machine count.
- **The dev servers** compute the same function live — every machine on boot, the affected machines on each rebuild — because there is no build step to consume. Programmatic `createApp` callers without a manifest (a hand-rolled `start.ts`) fall back to the same live computation.

The hash is attached to the def in `discoverMachines`, the one place every runtime already imports each machine, via a `WeakMap` keyed by def (defs are not frozen, so a symbol would also do; the map keeps the def type untouched). Whoever has the def at hydrate has the hash.

Why not compute at boot in production, which was this spec's first answer: it puts a build failure at the worst possible moment (prod-only, post-CI), and it scales boot time with machine count. The same function at build time has neither problem, and determinism (esbuild's output is a pure function of inputs and version, both in the hash) means the build-time value is the value boot would have computed. The cost of this choice is that the manifest is load-bearing in production — accepted, with the missing-entry boot error as the guard, and with `stator build` always producing it so the normal path never lacks it.

**Scale plan.** Build-time hashing is one esbuild call regardless of machine count; dev rebuilds hash only machines whose inputs changed. The numbers to watch, reported by `stator build` and the dev rebuild log: act when build hashing exceeds about a second or a dev rebuild's hashing exceeds about 100 ms on a real app. The responses, in order: confirm the single-invocation path is actually in use; cache by input-file content in dev across rebuilds; and only then consider a coarser closure (raw file hashing, no minify) for dev. No consumer is near this today; the plan exists so the first one that is doesn't find the answer ad hoc.

**Native TS contingency, now moot.** If the TS loader ever goes native, nothing here moves — production already consumes a build-time hash. The loader is kept for the TypeScript surface it gives app code (full TypeScript, no erasable-syntax rules to bubble up), which makes esbuild a deliberate dependency with four jobs — prod loader, dev loader, inspector bundle, machine hash — and a hard one regardless of the Vite exit.

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
- **Hash at production boot, manifest as a receipt** (this spec's first answer). Superseded: a bundling failure would surface only at prod boot after CI passed, and boot time would scale with machine count. Build-time computation has neither problem; the two-truths risk it reintroduces is closed by the missing-entry boot error.
- **Clear the store on dev reload, per machine.** Rejected: dev-only, destructive against a store the dev server does not own, keyed to a file edit rather than to the code a snapshot came from.
- **Per-machine migrations now.** Deferred; slot reserved.

## Open Questions

- **The reload key.** `EffectMeta` is `{ effectId, signal }` — an entry effect has no session identity, so after a reset it cannot know which durable cart to load unless the key lives outside the snapshot. Candidates: expose `sessionId` (and claims) on `EffectMeta` for session machines; or a `serverOnly` `RESUME { userId }` dispatched from middleware on the first request. Decide with the first real consumer (the store app's cart).
- **Measured cost.** `weather` (5 machines, 1–2 input modules each): **10 ms cold, 3 ms warm** for the whole single-invocation pass (2026-08-22, `hashMachines`). Far under the scale-plan thresholds; the build/rebuild timing reports still get wired so the numbers stay visible as apps grow.
- **Externalizing siblings vs inlining.** Externalized here (tighter); revisit if a real app shows a subscriber that should reset when its source machine changes.
- **App-machine reset acknowledgement.** A shared app machine resetting on deploy is more visible than a session reset; same rule, but the log line should make the trigger obvious.
- **Snapshot `format`.** Whether to add an engine-level `format` field alongside `code` so the snapshot shape itself can evolve (hierarchy in `value`). Cheap to add now; zero cost to defer since absent ⇒ current format.
- **`stator check`.** Whether the build-time diff should also run in `check`, so a developer sees "this change resets CartMachine sessions" before building.

## Implementation Notes

- Engine: `format?: number` and `code?: string` on `Snapshot`; `getPersistedSnapshot()` unchanged (the host stamps). `createActor` accepts the snapshot as today — the policy is the host's, applied before the actor is built. **Landed 2026-08-22** with `server/snapshot-policy.ts` (`stampSnapshot`, `reconcileSnapshot`, `snapshotResetReason`, `SNAPSHOT_FORMAT = 1`, rate-limited reset log at 1/10/100/…), wired into `SessionRuntime.loadOne`/`rehydrate`/`persistTouched` and `MachineStore.loadAppSnapshot`/`persistAppMachine`; `discoverMachines` hashes live by default (`hashes: false` for unit tests, a name-keyed map for the manifest path). A def with no registered hash is never reset for code — stores assembled from defs directly keep today's behaviour. Tests: `tests/snapshot-policy.test.ts`.
- Server: `machineCodeHash(files, { machinesDir })` in `server/machine-hash.ts` (one esbuild call, `write: false`, externals plugin for bare specifiers / `.stator` / sibling machines, versions appended; returns `{ [file]: { hash, inputs } }`); `discoverMachines(dir, loader, { hashes? })` attaches a supplied hash or computes live when none is supplied, and throws on a discovered machine missing from a supplied set; `loadProductionHead` (or a sibling `loadProductionManifest`) returns `machines` alongside `buildId`, threaded to `createApp` → discovery; `reconcileSnapshot(def, persisted) → { snapshot?: Snapshot; reset?: { from?: string; to: string } }` called from `SessionRuntime.hydrate` (`session-runtime.ts:67`), `SessionRuntime.rehydrate` (`:115`) and the app-machine boot path; stamping at `session-runtime.ts:270` and the app persist path; rate-limited reset logger.
- Build: `buildApp` hashes every machine (failing on an unbundleable closure) and writes `manifest.machines`; `stator build` prints the diff against the previous manifest when present and the hashing time. **Landed 2026-08-22**: `BuildResult.{machines, machineHashMs, resetMachines}`, `loadProductionHead(dist).machines`, `createApp({ machineHashes })` → `discoverMachines(…, { hashes })` (missing entry throws), `stator start` and `apps/store/start.ts` pass it through; a dist built before hashes existed has no `machines` and `createApp` hashes live.
- Dev: native server uses `metafile.inputs` for machines' affected set and rebuilds the store when any machine's inputs changed; both dev servers log changed machines on rebuild.
- Tests: the hash-function table above; reconcile unit tests (match, mismatch, absent, app path); one integration test per hydrate path; a dev-server test that edits a `lib/` file a machine imports and asserts the session reset + log line; a build test for the manifest receipt.
- Docs: `guides/persistence` gains the guarantee, the invalidation rule and the reload-on-entry idiom; `reference/machine` documents the rule and the `persist: true` wording; `reference/dev-and-build.md:40` loses "only a machine edit resets it"; README known-limitations gets one line. Changelog, stated as a commitment: *this release resets all persisted machine state once, because existing snapshots carry no hash; from here on, a machine's sessions reset only when that machine's code changes, and `stator build` prints which machines each deploy resets.*
- Related: [[store-adapter-with-per-session-ttl]] (the TTL this leans on), [[app-machine-state-persistence]] (the `persist: true` path), [[engine-effects-async-i-o-from-machine-transitions]] and [[entry-effects-state-entry-async]] (the durable-facts channel), [[session-identity-and-auth-primitives]] (claims already live outside snapshots — the precedent for "durable-ish state is not machine state"), [[toolchain-adapter-seam-and-the-vite-exit]] (esbuild as a deliberate runtime dependency; the native-TS contingency).
