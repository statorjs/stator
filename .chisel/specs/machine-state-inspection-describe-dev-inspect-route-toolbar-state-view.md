---
title: 'Machine state inspection: describe, dev inspect route, toolbar state view'
status: shipped
created: 2026-08-25
updated: 2026-08-25
area: tooling
---

## What and Why

The devtools thread wakes up. It was evidence-gated, and the evidence arrived: dogfooding the weather deployment, finding where a piece of data lived (saved places) took a grep to establish "it's `WeatherMachine` context, session-scoped" — the find-where-data-lives need. This spec ships the smallest slice that answers it, plus the substrate every later devtools surface shares.

The thread's original design (`.chisel/docs/introspection-manifest-and-checks.md`, 2026-08) was re-adjudicated against where the framework is today before committing this slice — it predates five structural shifts:

- **The Vite exit landed (2.6).** The dev server is framework-owned end to end — own loader, module graph, SSE reload channel, `serveDev` pre-filter. Dev surfaces no longer negotiate a foreign toolchain's module graph, and dev==prod server execution means dev tooling observes honest behavior.
- **The snapshot hydration policy shipped (2.6).** Machines carry runtime code hashes; snapshots are stamped; sessions reset on mismatch. An inspector can show truthful staleness — a concept that didn't exist when the thread was designed.
- **The `stator` CLI exists (2.2).** Terminal-native tooling has a home: `stator inspect`/`stator viz` are commands, not new binaries.
- **`serverOnly`, claims, and route `reads` are first-class runtime data (2.3+).** The admission/affordance story an inspector should display is fully introspectable.
- **The toolbar is already framework-owned** — improving it is an edit, not an integration.

The re-adjudication's outcome (2026-08-25): the in-page inspector remains the right first surface (only vantage with both planes; session scoping free via the cookie), the one-shot CLI is upgraded from "someday TUI" to a near-free fast-follow, the browser devtools extension stays deferred (packaging skin over access the in-page element already has), and the live TUI / manifest+viz / time-travel / prod-ops TUI / server observers all stay parked with their original gates.

The state inspectors have three legs: **SHAPE** (what machines exist, their charts), **STATE** (what's in them right now), and **LIVE** (transitions as they happen). This spec ships SHAPE-lite + STATE. LIVE stays with `observability-primitives-promoted` (traffic, not state — a different substrate).

Key grounding: almost everything needed is already introspectable at runtime. A `MachineDef` carries states, per-state `on` maps, guard/effect presence, emits, selectors, `serverOnly`, reads, subscribes — only the event *union* type is erased. Routes carry `reads: AnyMachineDef[]` in their compiled modules. App instances hold live snapshots; the session store holds persisted session snapshots keyed by (sessionId, machineName). Nothing new is authored; this is serialization of what exists.

## Success Criteria

- `describeMachine(def)` (engine, exported via `@statorjs/stator/machine`): a pure, JSON-able description of a def — states, per-event transition candidates (`to`/guarded/action/emits/effect), entry/after, machine-level `on`, handled-event list, `serverOnly`, emits, selectors, reads, subscribes, initial context. Closures stay opaque: presence, never bodies.
- `GET /@stator/inspect` (dev server only): the machine catalog (descriptions + code hashes), the **caller's own session's** persisted snapshots, app-machine live snapshots (labeled — they are process-global), and the route table with per-method `reads`/`live`. Cookie-scoped by construction: it serves the session the request's cookie addresses, never a cross-session dump.
- The inspector toolbar grows a **Machines** tab beside the wire log: per machine — lifecycle badge, current state, context (the find-where-data-lives answer), events accepted in the current state (serverOnly/guarded marked), and a stale chip when a snapshot's code hash no longer matches the running machine (the working-state policy made visible). Routes listed with their reads.
- Production never serves `/@stator/inspect` — including when a demo site opts into the wire toolbar (`dev.inspector: true`). The toolbar degrades: the Machines tab explains state inspection is dev-only.

## Constraints

- **The privacy line**: machine context is working state and may hold anything. Streaming server context to a browser is dev-gated, never production, and scoped to the requesting session's own cookie. App machines are the labeled exception (global, one per process).
- **Read-only**: the endpoint instantiates no actors, takes no session lock, dispatches nothing. Session snapshots come from the persistence store (a machine never touched this session reads as null — truthfully "would start from initial", shown dimmed from the def's initial context).
- **No new authoring surface**: nothing for app code to declare. The feature is derived entirely from defs, routes, and stores.
- The wire-traffic toolbar behavior is untouched; the tab is additive.

## Approach

- `engine/describe.ts` — the def walk, normalizing the three authored transition forms (bare action fn, config object, ordered candidate array) exactly as `actor.send` does. Precedent: `server/dev-lint.ts` already walks `def.states[*].on[*].to` this way.
- `server/inspect.ts` — payload assembly: `describeMachine` over `store.allDefs()` + `codeHashOf`, `store.persistence.get(sid, name)` per session def, `store.appInstance(name).actor.getSnapshot()` per app def, `routes[].{method}.reads` names + kind (page/api/query) + `live`.
- `server/http.ts` — `HttpConfig.inspect?: boolean` gates the route; the session id comes from the existing per-request session bridge (`getSessionState`). Set by `dev-native.ts` and the legacy `dev-vite.ts` (hatch parity), never by `createApp`.
- `client/inspector.ts` — tabs (Wire / Machines), fetch-on-open + refetch on `stator:patches-received` while visible, card per machine.

## Fast follows (planned, pending the substrate proving out)

- **`stator inspect [MachineName]`** — one-shot CLI: walk defs from cwd (`discoverMachines` + `describeMachine`), print the chart as text — states, events, guards/effects, `serverOnly`, selectors, lifecycle. No running server required for the SHAPE half.
- **`stator viz [MachineName]`** — the same description formatted as a Mermaid `stateDiagram-v2` block ("paste the diagram anywhere" — the seed the introspection doc identified).

## Open questions

- Dev-only session enumeration (an optional `Store.listSessions()`; InMemory trivial, Redis via SCAN) would let the toolbar show *other* sessions for two-browser workflows (live-poll, planning-poker, desksmith `/admin`). The old cookie-only stance is a prod argument that doesn't bind dev; deliberately left out of this slice, revisit on demand from a multi-session example.
- Whether island (client-plane) machines join the Machines tab next — needs a small dev-only client registry (`use()`/`machine()` registering instances), the one piece only the in-page vantage can ever show.

## Consumers and follow-ons

- First consumer: the toolbar Machines tab (this spec).
- The same description is the affordance substrate for the agent-readable routes idea (draft spec) — which events are dispatchable, which are `serverOnly`, per state.
- The manifest/viz/check thread consumes `describeMachine` when it promotes: a build-time manifest is this walk run at build over discovered defs, plus the compiler-side component half.
- The prod/ops TUI (forensic store reads by session id) remains a separate, later surface — it needs access control this dev endpoint deliberately does not have.