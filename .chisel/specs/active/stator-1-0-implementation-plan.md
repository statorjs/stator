---
title: Stator 1.0 implementation plan
status: draft
created: 2026-06-17
updated: 2026-07-03
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
  1.x tentpole. Rationale below. *(Revised 2026-07-03: richer declarative
  `subscribes:` deferred to 1.x; persistence stays. See the decision record.)*
- **Horizontal scaling: deferred to 1.x**, via a Redis pub/sub backplane on the
  existing `fanOut` choke point. Acceptable for 1.0; the current framework is
  already single-process.
- **Keyed `each`: in 1.0.** Inputs-in-lists is common enough to ship; the wire
  format already reserves insert/remove/move ops.

## Decision record (2026-07-03 review session)

A full project review (positioning, 1.0-readiness, code architecture) produced
a second round of decisions. These govern the remaining work and supersede
earlier bullets where they conflict.

**Architecture — one-way doors:**

- **Async I/O: minimal engine effects.** A transition may declare an `effect`
  whose completion dispatches a follow-up event through the normal event path.
  No invoke/spawn; engine core stays sync. Spec:
  [[engine-effects-async-i-o-from-machine-transitions]]. This must land before
  the proving demo (checkout needs it).
- **Grammar: JSX-parseability is permanent.** `.stator` templates must parse
  as TSX, forever — it is what makes the compiler and the Volar LSP cheap.
  Modifier-style needs (`on:click.prevent`) are met by **typed wrapper
  combinators** (`on:click={prevent(handler)}`), never new syntax. Document as
  a design principle.
- **Renders and selectors stay synchronous as a documented contract.** The
  module-global render/dispatch contexts are therefore sound; async lives only
  in effects and API-route handlers.
- **Packaging: raw TS as a declared stance.** `@statorjs/stator` keeps
  shipping `.ts` source; "Vite/tsx-native" is documented explicitly.
  Fix `files`/`repository` metadata. The language server keeps its `dist`
  build (VSCode needs CJS).
- **Client production build: Vite build + manifest.** Islands become Rollup
  inputs; a manifest maps component → hashed asset URL and the server injects
  script tags from it. Identity-import stubbing (server-machine import →
  `{ name }` in browser bundles) via a client-scoped Vite resolve plugin.
- **Public API: 7 stable subpaths** (`server`, `template`, `client`,
  `machine`, `components`, `dev`, `build`); `compiler` and `vite` are
  documented-but-internal and may change in minors.

**Scope:**

- **Keyed `each` authoring API:** explicit options argument —
  `each(items, fn, { key: item => item.id })`; omitting `key` keeps today's
  positional behavior. Works identically in `.stator` templates and raw
  tagged-template `html` calls.
- **Phase 5 reduced:** app-machine persistence IN; richer declarative
  `subscribes:` (source/predicate/transform) deferred to 1.x.
- **IN:** `fanOut` from non-POST entry points (webhooks/cron; the demo's live
  stock wants it); LSP surfacing of compiler semantic diagnostics + extension
  published to Marketplace/Open VSX with install docs; `apps/poll` rewritten
  in `.stator`; a minimal `create-stator` scaffolder.
- **Kept as-is:** `schema-dts` stays a regular dependency; session IDs stay
  raw UUIDs (documented stance; cookie-flag tests added).

**Release engineering:**

- **Versioning: the demo gates 1.0.0.** The remaining work list ships as
  0.9.x; 1.0.0 is cut only after the Allbirds demo proves the API needs no
  breaking changes. CHANGELOG starts at 0.9.
- **CI:** GitHub Actions — typecheck + full test run, including the
  language-server suite (the root `pnpm test` filter currently drops it), with
  a real Redis service container for `RedisStore` integration tests
  (auto-skip locally when no `REDIS_URL`).
- **Lint/format: Biome**, wired into CI.
- **API reference: hand-written** for the 7 stable subpaths (no typedoc — it
  would expose unblessed internals).
- **`.send` vs `.dispatch`: closed.** Two methods, as implemented — `send` is
  local/same-plane, `dispatch` crosses the wire.

## 0.9 push — ordered work list (2026-07-03)

Dependency-ordered; items reference the phases below where they overlap.

1. **CI + Biome** — protects everything after it.
2. **Session-lock unification** — `http.ts` and `api-route.ts` hold two
   independent `sessionLocks` maps, so `/__events` and API-route mutations on
   the same session do not serialize against each other. One shared lock
   module + a concurrent-events test.
3. **Wire module extraction** — the `Patch` union is declared in three places
   (`recompute.ts`, `client/runtime.ts`, `client/dispatch.ts`) and `Directive`
   in two, with two near-identical `applyPatches`. Single `wire/` module
   before any new patch ops exist.
4. **Prod client build + identity stubbing** (Phase 3 remainder, 6c/6d) — per
   the Vite-build-plus-manifest decision.
5. **Keyed `each`** (Phase 4) — on top of the wire module.
6. **Engine effects** — [[engine-effects-async-i-o-from-machine-transitions]].
7. **Phase 5 (reduced)** — app-machine persistence + `fanOut` from non-POST
   entry points (effects' completion delivery reuses the latter).
8. **Robustness test sweep** — SSE end-to-end (fan-out, cross-session,
   reconnect, push failure), Redis integration, XSS/escaping assertions,
   cookie flags, malformed `/__events` branches, `client/dispatch.ts`.
9. **Narrative + packaging pass — ✅ done 2026-07-04** (except two
   remainders): READMEs rewritten for the 1.0 surface (raw-TS stance
   documented); WIRE.md SSE section current; package metadata + `files`
   allowlists; `apps/poll` rewritten in `.stator` (verified over HTTP);
   `create-stator` scaffolder (verified end-to-end via file: install —
   caught and fixed two consumer packaging bugs: @hono/node-server was a
   devDep, pino-pretty now optional); docs: marketing splash, hand-written
   API reference (7 subpaths), guides for effects/keyed lists/app
   machines/production/editor setup, tutorial chapter 9 (async effects),
   stale claims fixed; versions bumped (framework + create-stator 0.9.0,
   language-server 0.1.0) + CHANGELOG started.
   **Remainders:** LSP semantic diagnostics (surface compiler errors in the
   editor — needs its own focused pass) and marketplace/npm publishing
   (needs credentials).
10. **Allbirds proving demo** — the 1.0.0 gate.

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

**Phase 0 — Consolidate baseline. ✅ Done.** (Done in spec terms: the four runtime
specs shipped with the poll demo are marked shipped.) Land the
`@statorjs/stator/machine` browser-safe export on main. Clean V1 start line.

**Phase 1 — Custom engine (the linchpin). ✅ Done.** [[custom-isomorphic-state-machine-engine]].
Typed event unions (kill `any` at `define-machine.ts:75-76`); isomorphic core
(server: dispatch context / reads / Store; client: local actor, no wire);
capability layers (server-pinned vs portable); compact snapshot serialization +
client hydration seed. Migrate the runtime and demos off XState; the existing
vitest suite is the regression gate. Highest risk, highest leverage.

**Phase 2 — Typed machine-mediated dispatch. ✅ Done (client half landed with 3b).** [[typed-events-and-machine-mediated-dispatch]].
`Machine.send` / `Machine.dispatch` off the imported def; kills the magic-string
`dispatch('Name', ...)` (used in the poll demo and the spike). Wire format
unchanged — the work is the typed surface + the identity-vs-value import
distinction. Rides on Phase 1's typed events.

**Phase 3 — `.stator` compiler + Vite. 🔨 3a done; 3b done including the production
plane (6c shipped 2026-07-03: `buildApp` bundles islands via one Vite build with
per-island inputs, hashed assets under `dist/static/assets/`, route→island
reachability in `dist/stator-manifest.json`, `loadProductionHead` injects at
serve; `machineStub` resolve plugin stubs server-machine imports to `{ name }`
in BOTH the prod client build and dev browser plane, gated on `!options.ssr`.
Also fixed: `.stator.ts` compiled routes now map to their source URLs, and the
build compiles route pages under the route capability set). Remaining: 6d
(collision check + the `{key}Changed` additive).** [[v1-compiler-against-real-templates]] +
the client half of [[client-scripts-directives-and-isomorphic-machines]]. TS-AST
transform → server module + client entry + scoped CSS, hosted as a Vite plugin
(build spike validated the orchestration and the `lang.css` constraint). `on:` /
`bind:` / `ref:` codegen; custom-element ownership; the import-boundary and
capability-portability compile errors (consumes Phases 1–2). Largest surface area.
Sub-staged **3a** (server compiler, no `<script>`) then **3b** (client plane) —
detailed build plan in [[stator-compiler-and-vite-plugin-implementation-plan]].

**Phase 4 — Keyed `each`. ✅ Done (2026-07-03).** [[keyed-each-and-list-item-identity]]
(shipped). `each(items, fn, { key })`; per-item insert/remove/move ops emitted from
a replay simulation; key-derived slot scopes (`s0:k<token>`) give rows identity so
inner bindings survive reorders; retained rows never re-render (content flows
through nested bindings); single-root-element and unique-key rules enforced at
render. Wire ops implemented in the shared wire module and documented in WIRE.md.

**Phase 5 — Single-replica cross-machine robustness. ✅ Done (reduced scope,
2026-07-03).** [[app-machine-state-persistence]] shipped: opt-in `persist: true`
app machines persist through the new `AppStore` (InMemory + Redis), boot
hydration with log-loud-start-fresh recovery, event-driven writes via the
touched set. `dispatchToApp` is the server-originated entry point (webhooks,
cron, effect completions) — send + persist + `fanOut`, closing the
"fanOut from non-POST entry points" item. Engine effects
([[engine-effects-async-i-o-from-machine-transitions]], also shipped) landed in
two stages around this: session plane first, app plane on top of it. Richer
declarative `subscribes:` ([[cross-machine-effects-source-predicate-transform]])
remains deferred to 1.x.

**Phase 6 — Polish. 🔨 Substantially advanced.** Done: Starlight docs site
(29 pages: intro, 8-part tutorial, concepts, guides), editor syntax
highlighting **plus** the Volar LSP + VSCode extension (Phases 0–1d of
[[editor-tooling-lsp-and-vscode]] — pulled forward from 1.x), dev inspector
toolbar, `apps/example` rewritten in `.stator`. Remaining (work list #8–9):
robustness test sweep; README/WIRE rewrite; package metadata; hand-written API
reference; docs home page; LSP semantic diagnostics + marketplace publish +
install docs; `apps/poll` rewrite; `create-stator`; single-replica boundary
page.

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
- Richer declarative `subscribes:` (source/predicate/transform as data —
  [[cross-machine-effects-source-predicate-transform]]). Deferred 2026-07-03;
  callback subscribes cover 1.0.
- Durable effects (survive process death; outbox semantics) — rides the inbox
  work. 1.0 effects are at-most-once, non-durable
  ([[engine-effects-async-i-o-from-machine-transitions]]).
- Editor intelligence beyond the shipped LSP: per-element attribute typing,
  directive-aware completions, formatting ([[editor-tooling-lsp-and-vscode]]
  Phase 2). *(The base LSP itself shipped ahead of schedule — see Phase 6.)*
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

All resolved as of 2026-07-03:

- ~~**Engine decisions that gate Phase 1**~~ — resolved by the shipped engine
  ([[custom-isomorphic-state-machine-engine]]): no delayed transitions in 1.0;
  flat `states`/`on` with typed event unions.
- ~~**`.send` vs `.dispatch`**~~ — **two methods**, as implemented: `send` is
  local/same-plane, `dispatch` crosses the wire.
- ~~**`.stator` body grammar depth**~~ — **JSX-parseability is a permanent
  constraint** (decision record above); combinators over modifier syntax.
- ~~**Editor tooling in 1.0 or after**~~ — shipped early: highlighting + Volar
  LSP + VSCode extension are in; semantic diagnostics + marketplace publish
  are in the 0.9 work list; deeper intelligence is 1.x.
- ~~**Phase ordering of 5 vs. 3**~~ — settled by the ordered work list:
  Phase 5 (reduced) lands after effects, before the robustness sweep.

Remaining open design questions live in
[[engine-effects-async-i-o-from-machine-transitions]] (failure default, effect
context surface, idempotency ids, app-machine effects).

## Implementation Notes

Planning document; updated as phases complete. **Status (2026-07-03):** Phases
0–2 done; Phase 3 done except the production client plane (6c prod build +
identity-import stubbing, 6d); Phase 6 substantially advanced (docs site, LSP +
extension, example rewritten). A full project review on 2026-07-03 produced the
decision record and the ordered 0.9 work list above, which now govern
sequencing; the Allbirds demo gates the 1.0.0 version. New spec spun out:
[[engine-effects-async-i-o-from-machine-transitions]]. Predecessor: the design
thread that produced the client/dispatch/engine specs and validated the client
model, build pipeline, and forms+validation via spikes in `apps/private/`.

**Status (2026-06-25, superseded):** Phases 0–1 done (custom engine shipped,
XState removed); Phase 2 server-side dispatch done, client half deferred into
3b; Phase 3a done and 3b in progress. Phases 4–6 pending.
