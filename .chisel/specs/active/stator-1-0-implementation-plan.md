---
title: Stator 1.0 implementation plan
status: draft
created: 2026-06-17
updated: 2026-06-17
area: runtime
---

## What and Why

This is the synthesizing roadmap for Stator 1.0 — what gets built, in what order,
and where the 1.0 / 1.x line falls. It does not redefine designs; each feature
has its own spec. This document sequences them, names the critical path, and
records the scope decisions made while planning.

1.0's identity: **a server-canonical web framework with a great DX story, running
single-replica.** The headline is the `.stator` SFC, the client model (state lives
where it runs, declared by import location), typed machine-mediated dispatch, and
a small purpose-built isomorphic engine. Horizontal scaling and durable
app→session delivery are explicitly 1.x.

## Success Criteria

- The example apps are rewritten in `.stator` form and produce identical behavior
  (the compiler spec's own criterion).
- A reactive client-only component, a two-way form with isomorphic validation, and
  a typed client→server commit all work end-to-end in a `.stator` SFC. (All three
  are already spike-validated; 1.0 productionizes them.)
- XState is gone from `packages/stator`; events are typed.
- The framework runs correctly single-replica; the single-replica boundary is
  documented, with the Redis-backplane path named as the 1.x scaling route.
- The existing vitest suite passes throughout (regression gate for the engine
  swap).

## Scope decisions (made during planning)

- **Engine: lean + extension points.** Build the POC-equivalent surface; design
  internals so hierarchy/parallel can layer later. Justified by zero advanced
  statechart usage across all demos. See [[custom-isomorphic-state-machine-engine]].
- **Cross-machine: single-replica robust (a + c).** App-machine persistence and
  richer `subscribes:` are in 1.0; the inbox / app→session delivery (b + d) is the
  1.x tentpole. Rationale below.
- **Horizontal scaling: deferred to 1.x**, via a Redis pub/sub backplane on the
  existing `fanOut` choke point. Acceptable for 1.0; the current framework is
  already single-process.
- **Keyed `each`: in 1.0.** Inputs-in-lists is common enough to ship; the wire
  format already reserves insert/remove/move ops.

## Cross-machine boundary, in depth

Today machines compose via `reads:` (sync state access) and `subscribes:` (react
to another's `emit`), in-process, single-replica. SSE `fanOut` (in-process
`Map`, `sse.ts`) already delivers **cross-session live display updates** — every
connection whose route `reads:` a touched machine gets recomputed patches,
regardless of which session triggered the change. So cross-session realtime
dashboards/polls already work single-replica and are **not** part of the deferred
work.

What's deferred (1.x) is the **durable inbox** — and it is the single mechanism
that lifts two limitations at once:

1. **Multi-replica fan-out.** `fanOut` is in-process, so a POST on replica A can't
   push to a connection on replica B. A Redis pub/sub backplane (publish `touched`,
   each replica pushes to its local connections) fixes this with no design change
   to `fanOut`.
2. **Server-originated delivery to non-connected / state-mutating cases.** SSE can
   already push *display* updates from any server-originated change to a loaded,
   touched machine (a webhook/cron handler need only call `fanOut`). What it cannot
   do: (a) reach a session with **no open connection** (idle, or a non-live page),
   and (b) **transition a session's own machine** (SSE recomputes reads; it never
   processes an event into a transient session actor). Both need a durable
   per-session queue drained on the session's next request — the inbox.

Cheap optional 1.0 nicety (flagged, not committed): make `fanOut` callable from
non-POST entry points so webhooks/cron can push live display updates to
*connected* sessions, reusing all existing machinery. The durable/transition half
stays 1.x.

## Phased plan

Dependency-ordered. The spikes de-risked the *models*; this is productionization.

**Phase 0 — Consolidate baseline.** (Done in spec terms: the four runtime specs
shipped with the poll demo are marked shipped.) Land the `@statorjs/stator/machine`
browser-safe export on main. Clean V1 start line.

**Phase 1 — Custom engine (the linchpin).** [[custom-isomorphic-state-machine-engine]].
Typed event unions (kill `any` at `define-machine.ts:75-76`); isomorphic core
(server: dispatch context / reads / Store; client: local actor, no wire);
capability layers (server-pinned vs portable); compact snapshot serialization +
client hydration seed. Migrate the runtime and demos off XState; the existing
vitest suite is the regression gate. Highest risk, highest leverage.

**Phase 2 — Typed machine-mediated dispatch.** [[typed-events-and-machine-mediated-dispatch]].
`Machine.send` / `Machine.dispatch` off the imported def; kills the magic-string
`dispatch('Name', ...)` (used in the poll demo and the spike). Wire format
unchanged — the work is the typed surface + the identity-vs-value import
distinction. Rides on Phase 1's typed events.

**Phase 3 — `.stator` compiler + Vite.** [[v1-compiler-against-real-templates]] +
the client half of [[client-scripts-directives-and-isomorphic-machines]]. TS-AST
transform → server module + client entry + scoped CSS, hosted as a Vite plugin
(build spike validated the orchestration and the `lang.css` constraint). `on:` /
`bind:` / `ref:` codegen; custom-element ownership; the import-boundary and
capability-portability compile errors (consumes Phases 1–2). Largest surface area.
Sub-staged **3a** (server compiler, no `<script>`) then **3b** (client plane) —
detailed build plan in [[stator-compiler-and-vite-plugin-implementation-plan]].

**Phase 4 — Keyed `each`.** [[keyed-each-and-list-item-identity]]. Per-item
insert/remove/move (wire format already reserves the ops); the compiler extracts
`key` from the `each` callback.

**Phase 5 — Single-replica cross-machine robustness.** App-machine persistence
(small; extend `persistTouched` + boot hydration to app machines —
[[app-machine-state-persistence]]) and richer declarative `subscribes:`
(source/predicate/transform as data, not opaque callback —
[[cross-machine-effects-source-predicate-transform]]). Optional: `fanOut` from
non-POST entry points.

**Phase 6 — Polish.** Observability promotion ([[observability-primitives-promoted]]);
editor syntax highlighting; rewrite the example apps in `.stator` (compiler spec
success criterion); docs incl. the single-replica boundary.

**Real-world proving demo (after 3b).** Decided 2026-06-21: build a deep,
realistic **ecommerce storefront emulating Allbirds** as the framework's
validation target — it exercises every distinctive bet at once (session/app
machines, guarded checkout flow, client-only state via 3b, slot patches, live
stock via SSE, composition, routing, request/response). Sequencing: **finish
Phase 3b first**, then build the demo top-to-bottom against the full surface
(rather than letting the demo drive 3b's API). The existing `example` is the toy;
this is the real thing — variants, faceted filtering, pagination, real forms, real
checkout. Recursive composition (nested categories / threaded reviews) folds in as
a feature rather than switching domains.

**Critical path:** Phase 1 → Phase 3. Phases 2 and 4 ride alongside 3; Phase 5 is
the main scope lever and is largely independent.

## Deferred to 1.x

- The durable inbox / app→session delivery ([[app-to-session-subscriptions-via-inbox]],
  [[cross-machine-event-delivery-model]]).
- Horizontal scaling (Redis pub/sub backplane on `fanOut`).
- Statechart richness (nested/parallel/history/invoke) — extension points only.
- Editor LSP beyond syntax highlighting.
- **Owning the HTTP layer.** Decided 2026-06-21: keep **Hono for 1.0 as a thin
  runtime adapter**, not as the router. Stator's own matcher is the routing
  authority (rest params + specificity sort; GET/API dispatch and SSE/POST
  resolution all go through `matchPath`). Hono still carries real weight at the
  runtime layer — `Context` (`c.req`/`c.json`/`c.html`/`c.redirect`),
  `hono/cookie`, `hono/streaming` SSE, the `@hono/node-server` `serve()` adapter,
  and near-free multi-runtime portability (Node/Bun/Deno/Workers) via Web-standard
  `Request`/`Response`. Owning the full HTTP layer (stator-native `Context`
  carrying the render context / response surface / directives first-class) is a
  deliberate post-1.0 option; the `buildHonoApp` + matcher seam keeps the swap
  localized.

## Open Questions

- **Engine decisions that gate Phase 1** (owned by [[custom-isomorphic-state-machine-engine]]):
  delayed transitions in 1.0?; event-declaration syntax; extension-point internal
  shape; selector typing scope.
- **`.send` vs `.dispatch`** — one method (transport inferred from call-site
  location) or two (transport explicit). Owned by
  [[typed-events-and-machine-mediated-dispatch]].
- **`.stator` body grammar depth** — how much JSX the parser handles; pin the
  control-flow callback forms (`when`/`each`/`match`). Owned by
  [[v1-compiler-against-real-templates]].
- **Editor tooling in 1.0 or after** — syntax highlighting is cheap; an LSP is
  derivative work, likely 1.x.
- **Phase ordering of 5 vs. 3** — app-machine persistence is small and independent;
  could slot earlier if it removes a sharp edge sooner.

## Implementation Notes

(Planning document. Updated as phases complete. Predecessor: the design thread
that produced the client/dispatch/engine specs and validated the client model,
build pipeline, and forms+validation via spikes in `apps/private/`.)
