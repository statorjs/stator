---
title: Config API and the extensibility boundary
status: draft
created: 2026-08-15
updated: 2026-08-15
area: runtime
---

## What and Why

Stator's config surface grew organically into a **flat** bag (`store`, `appStore`, `sessionTtlSeconds`, `ssePingMs`, `inspector`, `port`) spread across the user-facing `StatorConfig` (`stator.config.ts`) and the internal `CreateAppConfig` / `DevAppConfig` / `HttpConfig`. Two pressures forced a step back before the surface calcifies for 1.0:

1. **Session policy is about to grow siblings** (cookie name, rotation), so a flat `sessionTtlSeconds` doesn't scale — the next option has no obvious home.
2. **Open "is this a plugin?" questions** on SSE and sessions, with no stated principle to answer them or the next one.

This spec sets the durable principle for what config owns, draws the built-in vs. plugin boundary, and records the config shape (nested bags) that makes the principle legible. It is the decision record behind the config restructure landed alongside it.

Related: [[store-adapter-with-per-session-ttl]] (the `Store` adapter contract and per-session TTL this groups under `persistence`), [[per-route-opt-in-sse-with-cross-session-fan-out]] (the SSE feature whose transport seam is recorded here), [[stator-1-0-implementation-plan]] (the Hono/`buildHonoApp` runtime seam), [[observability-primitives-promoted]] (the `observers` array reserved as a future top-level field).

## Success Criteria

- A one-sentence principle that decides where any *new* option goes, and whether a proposed capability is config, code, adapter, or nothing.
- A boundary that answers the open questions on the record: **SSE stays built-in + opt-in per route** (not a user plugin); **sessions stay core** (policy in a bag, adapter in `persistence`). Neither becomes a "plugin."
- A config shape where the principle is *visible*: infrastructure and policy are distinguishable at a glance, and every field has an obvious home for its next sibling.
- Invariants recorded so a future contributor can't accidentally break them: every field optional; no required machine-graph entry point; `persistence.app` optional + advanced.
- An explicit **anti-recommendation**: no general Astro-style plugin/integration/hook system for 1.0, with each Astro pain mapped to the Stator choice that avoids it, and the bar to revisit stated.

## Constraints

- **`StatorConfig` is new — no back-compat.** The config file (`stator.config.ts`, `loadConfig`) never shipped (added on `feat/stator-cli`, absent at `@statorjs/stator@2.1.0`). The nested shape is the only shape; `loadConfig` does no key normalization. (An earlier draft added a flat→nested deprecation shim in `loadConfig` — removed: it protected an API that never shipped and did nothing for the one that did.)
- **The programmatic API stays non-breaking (a minor, not a major).** `CreateAppConfig` / `DevAppConfig` (the `createApp` / `createDevApp` args) *did* ship flat at 2.1.0 (`store`, `appStore`, `sessionTtlSeconds`, `ssePingMs`, `inspector`). Removing those keys would be a breaking change → a major. Per the **major-cutover-pairing** policy (ROADMAP surface hygiene), the non-breaking shaping ships instead: both configs keep the flat keys **typed and `@deprecated`** alongside the nested bags, `resolveAppConfig` (`server/ config-compat.ts`) translates flat→nested at runtime with a one-time warning, and nested wins when both are set. Existing flat callers keep compiling and running. The flat-key **removal** is parked to ride the next major.
- **Public shape = major semver.** Once shipped, `StatorConfig` is a published contract; getting the shape wrong costs a major bump. This is why the shape is settled *before* it ships.
- **Out of scope (deferred, not rejected):** the `PushTransport` seam / `sse.ts` refactor is recorded below but **not implemented** in this change.

## Approach

### Principle

> **Config owns _how it runs_ (infrastructure + policy); code owns _what it does_
> (behavior).** Config never changes program semantics.

A route's `live: true`, a machine's `persist: true`, a subscription — these are *behavior*, declared in code next to the thing they affect. TTLs, ports, the persistence backend, the heartbeat interval — these are *how it runs*, declared in config. When unsure where a new option goes, ask: does it change what the program *does*, or only how the same program *runs*? The former is code; the latter is config.

Keep the **two-layer split**: the user-facing `StatorConfig` is small and declarative; the internal wiring seams (`CreateAppConfig`/`DevAppConfig` → `buildHonoApp`/`MachineStore`) consume it. This is the antidote to Astro's merge opacity — there is exactly one place a user writes config, and it is a plain object, never an imperative builder.

### Four-tier taxonomy (there is no "plugin" tier)

1. **Irreducible core** — the event → recompute → patch pipeline, `SessionRuntime` + the session cookie, the `stator:*` observation events. Not configurable, not swappable; they *are* the framework.
2. **Pluggable adapter** — a small user-swappable contract behind a stable interface: `Store` (→ `persistence.session`) and `AppStore` (→ `persistence.app`). The user constructs the adapter and hands it in; explicit instantiation, no string-keyed discovery. (The [[store-adapter-with-per-session-ttl]] spec explicitly rejected `{ store: 'redis' }` magic for exactly this reason.)
3. **Core-with-seam** — built-in, with an *internal* interface that enables a future swap without a user-facing plugin: the SSE transport, the Hono/HTTP layer (`buildHonoApp`), client-runtime injection, `headExtras`. Users don't configure the seam; the framework owns it and may reimplement behind it.
4. **Optional toggle / registration** — a boolean or an order-independent array: `dev.inspector`, and the future `observers` array. No ordering, no lifecycle hooks, no merge.

Every real Stator capability lands in one of these four. None is a "plugin" in the Astro sense (a package that mutates config through lifecycle hooks).

**Tier-4 toggle vs. a banned behavior toggle — the line.** A boolean is only allowed in config when flipping it does *not* change program semantics. The test is the principle itself ("config never changes program semantics"):

- `dev.inspector` is allowed — it toggles a **dev-only diagnostic overlay's presence**. The app serves identical responses and behaves identically with it on or off; only an observability tool appears. That's "how it runs," tier-4.
- A security check like `checkOrigin: true` is **banned** — it changes *request-admission semantics* (which requests the app accepts). That is behavior, and it belongs in code (middleware), with config supplying only the *data* the check reads (`origin` / `trustedOrigins`). See the security spec (2.3): `origin`/`host`/`trustedOrigins` enter config as **data**; the origin check ships as default middleware, not a config flag. Those flags are deliberately **absent** from this (2.2) config for that reason.

Smell test for a proposed boolean: if its only effect is to switch a code path that changes what the program *does* (accepts, rejects, exposes), it's behavior — push it to code and keep only its *data* in config.

### SSE transport seam (recorded, deferred)

SSE stays **built-in and opt-in per route** (`route.live`), never a user plugin. Today `fanOut` in `sse.ts` is a module-level choke point with no abstraction — a hardcoded transport. The recorded (not-yet-built) extension point: an internal `PushTransport` / `PushConnection` interface behind `fanOut`, with the current SSE code becoming the default `SseTransport`. A future `WsTransport` and the 1.x Redis backplane slot in there. This is a **tier-3 core-with-seam**, an internal extension point — *not* a `config.realtime.transport` plugin entry. `realtime` is named protocol-neutrally (not `sse`) precisely so a future WS transport doesn't make the key a lie, but the transport choice is the framework's, not the user's, for 1.0.

### Anti-recommendation: no general plugin system for 1.0

A general Astro-style plugin/integration/hook system is **rejected** for 1.0. It contradicts Stator's "explicit instantiation, no magic discovery" philosophy and would import Astro's worst failure modes. Each Astro pain → the Stator choice that avoids it:

| Astro pain | Stator choice that avoids it |
| --- | --- |
| Imperative `updateConfig` deep-merge → unknowable final config | One plain declarative object; no merge, no builder. |
| Order-dependent integration arrays | The only array (`observers`) is order-**independent** by contract. |
| Adapter-vs-integration confusion | One concept per tier; adapters are the *only* user-swappable contract. |
| Hook-API churn (spawned `astro-integration-kit`) | No hook API to churn; seams are internal. |
| Peer-dependency friction | Adapters are constructed by the user from first-party exports. |

Astro's genuine *wins* — the adapter (deploy target) and renderer (UI framework) small-contract patterns — are preserved: they map to tier-2 pluggable adapters. What's rejected is the general integration/hook layer on top.

**Bar to revisit:** a real third-party ecosystem that needs to *inject routes* or *add middleware* from a package. Until that exists, adapters + typed option-bags + internal seams + the single `observers` array cover every actual need.

### Config shape (decision)

```ts
interface StatorConfig {
  port?: number                       // --port flag > $PORT > this > 3000
  persistence?: {                     // tier-2 adapters, grouped by concern
    session?: Store                   // was: config.store
    app?: AppStore                    // was: config.appStore (advanced)
  }
  sessions?: { ttlSeconds?: number }  // policy only; was: config.sessionTtlSeconds
  realtime?: { pingMs?: number }      // policy only; was: config.ssePingMs
  dev?: { inspector?: boolean }       // was: config.inspector
  // observers?: Observer[]           // top-level when the observability spec lands
}
```

Why this shape:

- **Persistence grouped by concern.** `persistence: { session, app }` is the one durability block holding the two swappable adapters. Chosen over `sessions.store`
  + top-level `appStore` because it removes the generic-`app`-naming problem (the whole config is "about the app"), and makes the infra-vs-policy split visible: adapters live in `persistence`, everything else is policy.
- **Lifecycle/feature bags hold policy only.** `sessions` (ttl, and future cookie/rotation), `realtime` (pingMs), `dev` (inspector). Each bag gives the next sibling option an obvious home — the pressure that started this spec.
- **`realtime` is protocol-neutral** so a future WS transport doesn't rename the key.
- **`port` stays flat** — it's neither infra-adapter nor a policy family; it's the one true scalar.

The internal `CreateAppConfig` / `DevAppConfig` mirror the nesting so a hand-written `server.ts` and a `stator.config.ts` read identically. `HttpConfig` stays flat (internal plumbing): `create-app.ts` / `dev.ts` destructure the nested bags into `buildHonoApp`'s flat `inspector` / `ssePingMs` and `MachineStore`'s `sessionTtlSeconds` / `appStore`.

### Invariants (must not regress)

- **Every config field is optional.** An absent or empty config boots on defaults (in-memory persistence, 24h TTL, port 3000). `stator dev` with no `stator.config.ts` works.
- **No required machine-graph entry point.** Machines are file-discovered from `machines/`; config never names a root machine. (`persistence.app` is *not* an entry point — it's durable storage for `persist: true` app machines.)
- **`persistence.app` is optional + advanced.** Default in-memory = restart-wipe. Most apps never set it. It is not required and never becomes so.

## Alternatives Considered

- **`sessions.store` + top-level `appStore`** — puts the session adapter inside the session policy bag. Rejected: splits the two adapters across two homes, and the top-level `appStore` name is unclear (the whole config is about the app). The by-concern `persistence` block keeps both adapters together and legible.
- **`app.store` lifecycle bag** — a single `app` bag holding store + lifecycle. Rejected: `app` is too generic (the entire config object is about the app), and it re-mixes infra with policy.
- **Keep it flat** — least churn. Rejected: the session-policy siblings (cookie, rotation) have nowhere to go, and flat gives no visible infra-vs-policy signal.
- **General plugin/integration system** — see the anti-recommendation above. Rejected for 1.0.
- **SSE as a first-party plugin** — rejected: it's core-with-seam (tier 3), opt-in per route in code, not a config plugin.

## Open Questions

- Exact `sessions` siblings when they land: `cookieName`, `rotation` policy shape — reserved but not wired.
- When [[observability-primitives-promoted]] lands, confirm `observers` is a top-level order-independent array (tier 4), not a bag.
- Timing of the `PushTransport` seam extraction (blocked on a second transport or the Redis backplane actually being built — don't abstract on one implementation).

## Implementation Notes

Landed with this spec:

- `packages/stator/src/config.ts` — `StatorConfig` restructured to the nested shape above; `defineConfig` unchanged.
- `packages/stator/src/cli/config.ts` — `loadConfig` returns the loaded object as `StatorConfig` directly; **no key normalization** (the config file never shipped, so there is nothing to translate). An earlier flat→nested `normalizeConfig` shim + its `tests/cli-config.test.ts` were removed as misplaced.
- `packages/stator/src/server/create-app.ts` + `server/dev.ts` — `CreateAppConfig` / `DevAppConfig` gain the nested bags *and* keep the flat 2.1.0 keys as `@deprecated` type members (non-breaking). Both route config through `resolveAppConfig` (`server/config-compat.ts`, tested in `tests/config-compat.test.ts`), then feed the resolved values to the flat internal `HttpConfig` (`buildHonoApp`) and `MachineStore` options. `HttpConfig` kept flat (internal plumbing).
- `cli/commands/dev.ts` + `start.ts` — pass the nested bags straight through.
- Call sites updated: `examples/{desksmith,live-poll,weather}/stator.config.ts`, `apps/store/start.ts`, `apps/private/spike/*`, and the config-shape tests (`session-lock`, `sse`, `dev-server`).
- Docs updated: `reference/server.md`, `reference/dev-and-build.md`, `guides/persistence.md`, `guides/app-machines.md`, `tutorial/01-setup`, `tutorial/07-persisting-state`, `introduction/installation`.

**Not** landed (deferred per scope): the `PushTransport` / `sse.ts` seam extraction. Recorded above as a future tier-3 extension point.

This config + CLI work is 2.2, the first step of the release sequence in [[toolchain-adapter-seam-and-the-vite-exit]]; the security-owned flags (`origin`/`host`/`trustedOrigins` + the origin-check middleware) land in 2.3, not here.
