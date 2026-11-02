---
title: 'Agent tools from the state graph: the WebMCP skin'
status: draft
created: 2026-10-28
updated: 2026-10-28
area: architecture
---

## What and Why

Refines [`agent-readable-routes-affordances-from-the-state-graph`](./agent-readable-routes-affordances-from-the-state-graph.md) (2026-08-25). Recorded 2026-10-28 from the AG-UI / WebMCP assessment. The parent spec's claim stands unchanged: **affordances that are never stale, because they are derived from the compiled state graph and evaluated against live guards.** What changes is the skin. The parent chose a bespoke HTTP envelope and called the envelope "the least important decision". WebMCP makes that decision for us.

WebMCP is the browser's own registry for in-page agent tools: `document.modelContext.registerTool({ name, description, inputSchema, execute, annotations }, { signal })`, plus `getTools`, `executeTool`, and a `toolchange` event. W3C Web Machine Learning CG draft (last edited 2026-10-27), Chrome early preview since 2026-02, the getter moved from `navigator` to `document` mid-2026, Firefox and Safari uncommitted. It answers three of the parent spec's open questions with the platform instead of with Stator-invented surface:

- **Envelope** — `registerTool` with JSON Schema `inputSchema`. No XML-vs-JSON question, no bespoke document.
- **Discovery** — `getTools`. No UA sniffing, no `<link rel="alternate">`, no `llms.txt`, no content negotiation.
- **Session bootstrap** — gone. The agent is in the user's browser, so the user's session *is* the session. `execute` runs in-page and POSTs the existing wire with the existing cookie.

It also removes the direction problem AG-UI had. An app-embeds-agent protocol needs a streaming push source into session machines (a primitive the ROADMAP defers). A browser-brings-agent protocol needs nothing from the agent side at all: the page exposes affordances, the browser does the rest.

**Why Stator and not the incumbents — structural, not effort.** Surveyed 2026-10-28: React has four registration shims (Chrome Labs' own `use-webmcp-tool` among them), Svelte has two community packages, Vue/Nuxt/Astro/Remix have nothing. Every shim is the same fifty lines — register on mount, abort the signal on unmount, no-op when the API is absent — and every tool is hand-authored: `name`, `description`, `inputSchema`, `execute`. MCP-B's framework guide states that none of its integrations derive tools from routes, forms, state, or schemas. They cannot: a React `onClick` is an opaque closure, so nothing in the component tree says "this sends `ADD` with a `productId`, only while the cart is open". The two shipped derived cases prove the rule — RxDB generates CRUD tools from collection JSON Schema (data-shaped, no workflow, no guards), and Outline registers its command-bar actions with the UI's visibility rules (an action registry it had already built). Both needed a declarative layer the app already had. Stator's machines **are** that layer, with what no registry has: state-dependence, guards, server-side execution, typed payloads.

**Why now — the wedge, recorded honestly.** This spec is not backed by a paper-cut log. It is a go-to-market demonstration that incumbents structurally cannot copy, built over a substrate four other consumers already want (introspection manifest, MCP server skin, the drydock palette's derived availability, `stator check`). The framing that must survive WebMCP's possible death: **the chart is the app's API; WebMCP is one skin.** Tony's stance on record: dislikes WebMCP, doubts its future, wants the wedge anyway. Whether go-to-market evidence satisfies the evidence-before-primitives rule is an open adjudication (see Open questions); the Desksmith experiment below is the evidence either way.

## The tool model

A tool is **one client-dispatchable event of one machine the route reads, in that machine's current state.** Everything below is derived; the only authoring an app does is JSDoc on its event union.

**Source set, per route.** For each def in `route.reads` (`server/routing.ts:91`), the events that pass the availability pipeline below — state membership, live guard evaluation, and, once dispatch-site attribution lands, the live render — minus `serverOnly` (`engine/types.ts:272`) and explicitly hidden events. Before layer 3 lands the set is "chart parity"; after it, "human parity", the events the page actually renders a usable control for. The client-dispatch allowlist's promotion bar (`.chisel/docs/client-dispatch-allowlist.md`) was "a non-security manifest consumer"; this is that consumer.

| WebMCP field | Derivation | Source |
|---|---|---|
| `name` | `<MachineName>.<EVENT>` | def name + event type (WebMCP name charset is `[A-Za-z0-9_.-]`, 1–128 chars; non-conforming characters are encoded with the slot-id token scheme) |
| `title` | the event type | — |
| `description` | leading JSDoc on the union member | build pass (below); fallback `"<EVENT> on <MachineName>"`, flagged in dev as undescribed |
| `inputSchema` | JSON Schema of the member minus `type` | build pass |
| `annotations.consequentialHint` | `true` when the transition declares `effect` or `emit` | `describe.ts` reports both; effects are external I/O, emits reach shared app machines |
| `annotations.readOnlyHint` | `false` | every event is a write by definition |
| `execute` | the runtime's existing dispatch (`client/runtime.ts:336` → `transport.ts:75 postEvent`) with `{ type, ...input }` | unchanged wire: cookie, `X-Stator-Route`, `eventId` |
| result | `{ committed: boolean, reason?: string, reads: … }` | `committed` is already on the envelope; `reads` is the read-tool payload below so an agent sees the consequence of its action without a second call |

**Guards and refusals.** See the availability pipeline below: event-independent guards are evaluated live and decide the set; event-dependent guards mark a tool conditional. Either way a guard-dropped dispatch returns `committed: false` with a reason, never an exception.

**Read tools.** One per read machine, `<MachineName>.read`, `readOnlyHint: true`, `untrustedContentHint: true`, no input. Returns every declared selector's output evaluated against current context and helpers (selectors are `(ctx, helpers) => unknown`, all evaluable server-side). This is the parent's "serialize reads, not context" rule: selector outputs are the page's exposure boundary, and the agent's boundary must be the same or it is a leak. Served by a dispatch-free read on the route's machines — the data-GET-route machinery already does this.

**Islands.** Client machines register no tools, and client-only UI state never gates a tool — see "Excluded" under availability. Server events dispatched from inside an island are offered at chart parity for their machine.

## Availability — the triggerable set

A tool is offered only for an event the user could trigger *right now*. "Right now" has three sound sources, all held server-side, composed as a pipeline in which each layer only removes tools.

**Layer 1 — state membership.** The event is in the current state's `on` table or the machine-level `on` fallback (`engine/describe.ts` walks both). If `REMOVE` lives only in `open.on`, it does not exist while the cart is `closed`.

**Layer 2 — event-independent guards, evaluated live.** Guards are `(ctx, ev, helpers) => boolean`, pure of `(ctx, ev)` by contract (`engine/types.ts:48`). Most guards never read the event: `when: (ctx) => ctx.items.length > 0`, `when: (ctx, _ev, { reads }) => reads.Auth.role === 'admin'`. The build pass records `guardReadsEvent` per transition — whether the guard's second parameter is referenced in its body, a cheap AST check inside the pass that already walks every machine through the TypeScript checker (runtime `fn.length` is not enough: a role guard needs the third parameter and would look event-dependent). At availability time, per candidate transition: no guard → offered; guard does not read the event → called with `{ type }` against the current snapshot and helpers, offered iff true; guard reads the event → offered, marked conditional, because `ev.qty <= ctx.stock[ev.productId]` cannot be decided without arguments. An event with several candidates is offered if any candidate passes — the engine resolves to the first passing candidate (`engine/actor.ts:243`), so this is the engine's own answer. This amends the parent spec's "never fake an event": the rule is **never fake a payload**. A type-only event handed to a guard proven not to read it is not a probe, it is the call the engine would make.

**Layer 3 — UI parity from the live render.** An unguarded event is still untriggerable when its only control sits in an inactive `when()`/`match()` arm or on a disabled element. Recompute already holds both facts: every branch binding's active arm (`server/recompute.ts:221`) and every attribute binding's current value (`server/recompute.ts:102`). Once the compiler attributes each literal dispatch site to its machine, event, enclosing region path, and host element — the same attribution the client-dispatch allowlist needs — a tool is offered iff at least one of its sites is inside an active arm and its host element's `disabled` binding is not currently truthy. This is the parent spec's "human parity", computed per render and per session rather than statically. A machine with any non-enumerable dispatch site (computed event types, sites inside islands) falls back to layers 1–2 for that machine, per the parent's dynamic-tail rule.

**Excluded — client-only state (decided 2026-10-28).** A cart drawer whose open flag lives in an island, a `<details>` toggle, a CSS-hidden panel: the server cannot see these and the agent does not get them. The client could filter dispatch sites by `checkVisibility()` and re-check after every patch, but that chases the DOM, and visibility is not reachability — a control in a closed dialog is hidden yet one click away. Tony's call: client-only state is rare in Stator's model and agents do not need it to do anything useful. If openness decides what the user may do, it is chart state and belongs in the machine, where layer 1 sees it. Server events dispatched from inside islands are offered at chart parity. Client machines register no tools at all.

**Composition.** Offered iff: layer 1 passes, not `serverOnly`, not `@hidden`, layer 2 passes, and layer 3 passes where site attribution exists. Computed per connection — guards read session context and roles differ per session — at the end of recompute. Cost is a handful of guard calls per read machine per commit, negligible beside binding recompute.

**Advisory, never the boundary.** The set is a snapshot. An agent can call a tool a moment after it vanished and the dispatch path still guards, exactly as a human can click a button a split second before it disables. Filtering tools is UX for the agent; admission at `/__events` is authoritative. The agent gets one thing the human does not: a refused call returns the reason (`committed: false`, `reason`), where the human only sees a greyed button. The refused-dispatch-reasons thread gains its consumer here.

## Availability delivery

The triggerable set changes whenever a read machine transitions, a guard's inputs change, or an arm flips. The server already knows all three: recompute runs after every commit.

- **Initial set** — rendered inline on the page (a JSON script block the runtime consumes at boot). Non-live routes have no stream to receive it over, and a page should be agent-ready before its first interaction.
- **Changes** — at the end of recompute, the server computes the route's tool set and compares it with the connection's last-sent set; on difference it emits a `tools` directive, `{ type: 'tools', set: Tool[] }`, full replacement (sets are small; snapshot semantics are simpler than diffs and match WebMCP's own `getTools` model). It rides the envelope exactly as `navigate` does: the originator's POST response, SSE for other observers on live routes. The directive union (`wire/index.ts:42`) was designed to grow this way; clients that predate it ignore it with a `console.error`. WIRE.md gains the directive.
- **Client** — one `AbortController` per registered tool. On a `tools` directive, diff by name: abort what vanished, register what appeared, leave the rest (Chrome Labs' hook re-registers only on name change; we match, since state changes never change a tool's schema). The browser fires `toolchange` for the agent.
- **Non-live routes** — the originator's own responses carry the directive, so single-user flows track state. Cross-session changes are not tracked, exactly as the page's own bindings are not. Consistent with the existing contract.

## Config and opt-in

- `stator.config.ts`: `agents?: { webmcp?: boolean }`. Absent or `false` = nothing rendered, nothing registered, no inline block. Mirrors `images` (absent = no routes mounted). Off by default while the spec is a draft and WebMCP is a CG draft.
- **Hiding an event**: a `@hidden` JSDoc tag on the union member, read by the same build pass as the description. Authoring locality wins over a second runtime list on the def. Hidden ≠ consequential: `CHECKOUT` is consequential and offered (it is the whole demo); `DELETE_ACCOUNT` is hidden by its author. Outline's "destructive excluded by default" is the right instinct but we cannot know "destructive" from the chart; `consequentialHint` is what we *can* know, and it is what the browser's own consent UI keys on.
- **Permissions Policy**: WebMCP gates on the `tools` feature, default allowlist `'self'`. Stator's security-headers middleware sets no `Permissions-Policy` today, so nothing changes; a user-authored policy must keep `tools=(self)`. Cross-origin `exposedTo` is not supported — same-origin only, by decision.

## The build pass — event payload schemas

The one genuinely new piece of work, exactly as the parent spec predicted. The `events` declaration is `{} as CartEvents`, a type assertion on an empty object, erased at runtime; `describeMachine` has event *names* only (`describe.ts:51`).

- Walk each discovered machine module, resolve the `events` property's type through the TypeScript checker, split the discriminated union on `type`, emit per member: JSON Schema (minus `type`), the leading JSDoc comment as `description`, and `hidden` from a `@hidden` tag.
- Output lands in the build manifest beside `machineHashes` and is consumed by `createApp` the same way (`server/create-app.ts:108`). Dev computes it live from the compiler's program when a machine module changes — the dev loop already re-walks machines for hashing, so the hook exists.
- Unschematizable members (function-typed fields, class instances, `unknown`) emit `{}` with a dev warning. The build **does not fail** for this, unlike unbundleable closures for hashes: a loose schema is a description-quality problem, not a correctness problem.
- This is the shared prerequisite the introspection manifest, the MCP server skin, `stator check`, and the palette all wait on. This spec is the first consumer to ship it.

## Security

- **Zero new capability.** `execute` is a browser POST to `/__events` with the session cookie, the route header, and an `eventId`. Guards, `serverOnly`, origin checks, CSRF, idempotent replay — all unchanged. The agent acts as the user, on this page, through the page's own path. App machines stay unreachable except through the gateway pattern. This is the parent spec's entire security story and it is unchanged.
- **Exposure boundary.** Read tools serialize selectors, never context. Same boundary as the HTML.
- **Prompt injection.** Tool descriptions are static strings from source — never derived from data, never templated with context. Read tools carry `untrustedContentHint`. Agent-supplied payloads are untrusted input exactly as any browser POST is; the wire edge validates `{ machine, event.type }` only today, and the schema this pass emits is the schema `/__events` *should* validate payloads against — recorded as a follow-up, not scope.

## Success criteria

- An app sets `agents.webmcp: true` and every route registers tools with no app code. Desksmith gets its tools with only JSDoc comments added to `CartEvents` and `CheckoutEvents`.
- The set tracks state: after `ADD`, `CartMachine.CHECKOUT` appears; once checkout begins, `ADD` disappears, exactly as the chart says.
- Layer 2 is visible: an empty cart offers no `CartMachine.EMPTY`; a session whose `AuthMachine` role is `viewer` sees no edit tools on the admin route — with no app code beyond the guards it already has.
- Layer 3 is visible once site attribution lands: a control inside an inactive arm or on a disabled element yields no tool.
- A guard-dropped call returns `committed: false` with a reason. No tool call ever throws into the agent.
- In Chrome Canary with the WebMCP testing flag: `document.modelContext.getTools()` lists the derived set; `executeTool` round-trips through `/__events` and the page patches as if the user had clicked.
- Off by default; when off, no inline block and no registration. The runtime module's cost when shipped-but-off is measured, not assumed.

## Evidence gate — the Desksmith experiment, reshaped

The parent spec's gate, now cheap and standard-shaped. Per the draft, `getTools` and `executeTool` are callable from page script, so a Puppeteer/CDP harness in Chrome Canary can enumerate and call the registered tools without waiting for Gemini-in-Chrome access.

- **Task**: add two items to the cart, then complete checkout.
- **Arms**: (a) an LLM-driven script that enumerates `getTools`, plans, and calls `executeTool`; (b) the same model DOM-driving the same flow through the accessibility tree / screenshots.
- **Metrics**: steps, tokens, success rate over N runs.
- **Ship rule**: the feature leaves draft only if tools show a clear win. If they do not, the derivation still ships as manifest substrate for its other consumers and the WebMCP skin stays a flag.
- **Secondary artifact**: the recording *is* the wedge — the deployed storefront, a browser agent asked to buy two of the cheapest desk, checkout completing through guarded events while an admin tab updates live over SSE, zero lines of app code touched.

## Sequencing

1. Build pass: schemas + descriptions + `@hidden` + `guardReadsEvent`, into the manifest, live in dev.
2. Server: per-connection triggerable set (layers 1–2) at end of recompute, inline initial set on render, `tools` directive; WIRE.md addendum.
3. Client: registration module behind `agents.webmcp`, `execute` through the existing dispatch, result with `committed` + `reason` + reads.
4. Read tools.
5. The experiment, then the recording.
6. Layer 3, when dispatch-site attribution lands (shared with the client-dispatch allowlist).

Deferred, same substrate: a `stator mcp` server skin for CLI agents with no user present; the parent spec's HTTP envelope, demoted to "if a consumer appears".

## Alternatives considered

- **Hand-authored `registerTool` in islands** (what every other framework does) — rejected as the thing this spec exists to avoid. Still *possible* for custom tools beside the derived ones, as RxDB allows.
- **Derive from template dispatch sites only** (human parity first) — deferred; chart-derived minus `serverOnly` is the honest superset today, converge when the allowlist lands.
- **Declarative `<form toolname>`** — not in the WebMCP spec (the README says it is only being explored); the Stator forms pattern could map later.
- **Ship the chart to the browser and derive client-side** — rejected; server machines collapse to identity stubs in client bundles and stay that way.
- **Island / client-machine tools** — rejected 2026-10-28: client-only state is rare in Stator's model and agents do not need it to do anything useful; what matters is chart state, where layer 1 already sees it.
- **Client-side visibility filtering** (`checkVisibility()` over dispatch sites) — rejected: chases the DOM, and visibility is not reachability.
- **Guard probing with fabricated payloads** — rejected, as in the parent spec; only guards the compiler proves event-independent are evaluated.
- **AG-UI** — parked (assessment 2026-10-28): app-embeds-agent needs a push-source primitive and only pays off with an external agent Stator does not own.

## Open questions

- Does the wedge count as evidence under evidence-before-primitives? Tony adjudicates; the experiment result is evidence either way.
- Naming: `Machine.EVENT` as above, or lowercase-snake for LLM friendliness? Decide with the first harness run.
- Event-dependent guards: offered as conditional (current) vs hidden. Experiment data decides.
- Payload narrowing from the render: a `REMOVE` site inside a keyed `each` knows the rendered keys, so the schema could carry an `enum` of current ids. Cheap, precise, and a signal recompute already holds — a refinement after layer 3.
- Read-tool granularity: per machine (current) vs one per route.
- Payload validation at `/__events` against the emitted schema — follow-up spec, becomes pressing once agents are a real caller.
- WebMCP churn: the `navigator`→`document` move broke every 0.x package in the ecosystem. Stator hides the API behind the runtime, so churn is a maintenance line, never an app-facing break — but the registration module must feature-detect both until Chrome stable settles.
