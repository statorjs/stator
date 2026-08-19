# Client-dispatch event allowlist — the `/__events` gate (territory note, 2026-08-13)

> **Not middleware.** This is a build + runtime **security** feature: prevent a
> hijacked/malicious client from POSTing events the legitimate UI never sends
> (effect completions, cross-machine internals, server-only signals). It rides
> the **server-only-events** and **introspection-manifest** roadmap tracks, and
> is the concrete *security* promotion trigger the manifest was waiting for. Kept
> deliberately separate from route-auth middleware — they operate at different
> layers (event-dispatch vs request-routing) with different sources (compiler vs
> author config).

## The core insight — source the allowlist from *usage*, not the chart

The naive allowlist is "events the chart handles minus server-only." Wrong source: the chart-handled set includes completions (`COMMIT_OK`, `SAVE_FAILED`), timer events, and cross-machine internals — all handled, **none client-sent** — so a chart-derived allowlist would *permit* a client to forge them.

The right source is **the set of events the client code actually dispatches** — every template `on:click={() => m.send({ type })}` and island `dispatch(M, { type })`. The compiler already lowers those sites, so for literal event types it is statically enumerable, per machine. That set:

- **excludes completions/internals/server-only by construction** — a client that never sends them is definitionally illegitimate when it does;
- is *tighter* than chart-handled and needs no explicit flag for the common case.

Enforcement: `/__events` checks the incoming event `type` against the target machine's **client-dispatch set**; reject if absent.

## What it resolves for free

- **Effect-completion forgeability** (open FINDINGS item — "could a forged `COMMIT_OK` mark a record committed?"): completions aren't client-dispatched → rejected. Closed by construction, no per-event ceremony.
- **Hijacked-client server-only events** (the motivating case): a server-only signal the UI never sends is not in the set → rejected.
- **Phantom prototype-collision events** (`toString`, …): not client-dispatched either → rejected at the boundary, complementing the engine-side `hasOwn` fix.

## Explicit `server-only` sits on top — intent + a compile check

Usage-derivation is the sound default; explicit declaration is the override that makes intent auditable and catches mistakes:

- Mark an event/machine **server-only** → rejected at `/__events` regardless of usage.
- The compiler then flags the contradiction: **a `server-only` event with a client dispatch site is a compile error** ("you dispatched a server-only event from the client") — `stator check`'s heuristic tier applied to security. This is the strongest form of "the build audits what a client may send."

## Convergence — one substrate, several consumers

The manifest's per-machine surfaces feed multiple features, each a different projection:

- **`/__events` client gate** → the *client-dispatch* projection (this note).
- **`stator check` dead-event lint** → the *chart-handled* projection (handled nowhere = dead).
- **Server-only events** → the explicit *server-only* projection (the override).
- **Phantom-event `hasOwn` fix** → the engine-side floor, independent of the manifest but the same class of "reject events that aren't really there."

## Layering caveat (so it isn't over-read)

The allowlist gates **origin legitimacy** ("did a client ever send this event"), **not** per-user/per-context authorization. A `DELETE_ALL` button on an admin page puts `DELETE_ALL` in the allowlist for *every* client; whether *this* user may commit it is still the machine **guard's** job. Coarse gate + fine guard, same layering as route middleware vs guards.

## Design edges (territory, not spec)

- **Dynamic dispatch.** Islands can `dispatch(M, computedType)`; literal types are enumerable, dynamic ones aren't. Fallbacks to decide later: fall back to chart-handled for that machine (looser), require an explicit client-events declaration, or forbid dynamic client dispatch (compile error).
- **Dead client dispatch.** A client-dispatched event the chart doesn't handle is allowed-but-no-ops (origin-legitimate, zero-effect) — and `stator check` would separately flag it. Two orthogonal checks.

## Semver / discipline

Non-breaking **in practice** — the events it newly rejects are forgeable completions/internals no legitimate client posts (a security fix). Ships as the **non-breaking shaping**: preserve today's silent-drop for legitimately-unhandled events; hard-reject only not-client-dispatched + server-only + phantom. The *blanket* reject-unknown-with-400 remains the deferred major-cutover (`ROADMAP.md` major-cutover-pairing policy).

## Enforcement is production-only (decided 2026-08-16)

The 403 gate runs in **`stator start` (prod)**, not `stator dev`. Dev has no malicious attacker, and enforcing there would force the whole per-machine allowlist to be available at *dev* runtime (the dev server compiles on demand, so a partially-compiled app couldn't reject correctly) — the one part that risked becoming a dev-pipeline rabbit hole. Instead:

- **Build** computes the per-machine client-dispatch set and writes it into the prod manifest; `stator start` loads it and enforces at `/__events`.
- **Dev correctness feedback** comes from **`stator check`** (which can flag un-enumerable dynamic dispatch) and **test coverage** — not runtime enforcement.
- Legitimate dispatches can't be falsely rejected either way: the allowlist *is* the client's dispatch sites, so anything the client really sends is in it by construction. Only forged / server-only / phantom events hit the 403.

## 2.3 scope (PR D)

Ship the **usage-derived** per-machine allowlist + the **prod `/__events` 403**. Preserve today's silent-`200` for events that are client-dispatchable but unhandled-in-state (non-breaking). **Defer** the explicit `server-only` *declaration* + its compile-time check — the usage-derivation already excludes any event no client dispatches, so the declaration is a later auditability layer.

## Non-goals

- Not middleware; middleware must never inspect events.
- Not per-user authorization (guards own that).
- Not a hand-maintained allowlist — the compiler derives it, the author only *overrides* via `server-only` (deferred).
