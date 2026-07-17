---
title: Conditional-arm interiors are second-class on the live-update path
status: ready
created: 2026-07-17
updated: 2026-07-17
area: runtime
---

## What and Why

Two independent, confirmed correctness bugs surfaced while building the
`examples/weather` app. Both share one root theme: **the interior of a `match`/
`when`/`each` arm is a second-class citizen on the live-update (SSE fan-out)
path.** Content rendered at the top level of a route updates correctly on the
wire; the *same* content rendered inside a conditional/list arm does not — it
either mis-targets its patch or renders stale.

Two independent bugs pointing at the same seam is the signal to do a focused
runtime pass rather than paper over each instance in app code. Both are
currently worked around in the weather example (see
`examples/weather/FINDINGS.md` #2 and #3), which is why that app is correct
today — but any user writing the obvious, natural template will hit these.

Neither is user misuse. Placing a client island, an `on:` handler, a
`read()`-bound attribute, or a `read()` text binding inside a `match`/`when`/
`each` is an ordinary thing to write. The framework accepts it, renders correct
initial HTML, and then silently does the wrong thing on the first/next live
update — no error, just a binding that quietly stops working.

### Bug A — element ids are a flat global counter, so an element-id'd node inside an arm gets an unstable id

Slot ids are arm-scoped and stable (`s3:bready:s1`). Element ids
(`data-stator-id`, used for **attr patches**, `on:` handlers, and client
islands) are a **flat sequential counter**, so a node's id depends on how many
element-id'd nodes rendered before it — which differs between an incremental
branch-swap render and a full-page render.

Concretely: a client island with a live `read()` attribute placed *inside* a
`match` arm got id `e0` in a full render but `e3` after a `loading → ready`
branch swap (the always-rendered nav buttons took `e0..e2` first). On a later
live update the attr patch targeted `e0` — which in the live DOM was a
**button**, not the island — so `setAttribute` landed on the wrong element and
the island never updated.

- **Symptom:** an attribute bound with `read()` (or an island / `on:` handler)
  on an element inside a conditional silently stops live-updating; the patch
  lands on the wrong node, or `wire/apply.ts` logs
  `patch target element "eN" not in DOM — skipped`.
- **Detection today:** the `apply.ts` "not in DOM — skipped" warning is a
  partial signal, but the id can also collide with a *real* element (as above),
  in which case there is no warning at all — it silently miswrites.
- **Suggested fix:** scope element ids to the arm the same way slot ids already
  are (`eN` → `s3:bready:eN`), so an element's id is stable regardless of
  surrounding conditional state. Slot ids already solved this; element ids just
  didn't inherit the solution.

### Bug B — a `read()` inside an arm renders STALE on the first data arrival (fan-out re-render uses a frozen closure proxy)

A live SSE connection keeps a long-lived runtime. When a mutation happens in
another runtime (a POST, or an `entry`-effect completion), fan-out
**rehydrates** the connection's actor — `SessionRuntime.rehydrate()` builds a
*new* actor, **stops the old one**, and swaps in a *new* proxy. `recompute`
then diffs:

- **Registered leaf bindings** (text/attr) are re-evaluated against the
  connection's *current* proxy (`conn.runtime.proxyFor(name)`) → **fresh**.
- **A re-rendered arm body** (branch key changed → `renderBranchBody` →
  `renderer()`) runs the arm's JSX, whose nested `read(m, sel)` uses the
  **render-time closure's** machine proxy — bound to the now-*stopped*
  connect-time actor, frozen at pre-data state → **stale**.

So in a single fan-out, a leaf binding and an arm-interior binding for the *same
machine* disagree. Observed directly in the weather cold-load: `evt1` delivered
`attr@e0 scene=clear-day` (leaf, fresh — data present) alongside
`html@s4 …<span>—</span>` (arm interior, stale — no data). Once the arm renders,
its interior `read()` *becomes* a registered leaf binding, so the *next*
recompute heals it — which is why "reload, or trigger any other event" fixes it.

- **Symptom:** data bound via `read()` inside a `match`/`when`/`each` arm shows
  the empty/placeholder value on the first render where the arm becomes active
  due to fresh data; corrects on the next update. Leaf `read()`s outside arms
  are fine.
- **Suggested fix:** during a recompute-driven arm re-render, resolve nested
  `read()` proxies from the *current* render context's runtime (by machine
  name) rather than trusting the closure-captured instance — e.g. stash the
  fan-out runtime on the `RenderState` so `read()` looks up `proxyFor(def.name)`
  freshly. Then arm interiors and leaf bindings always agree.

## Success Criteria

- An `on:` handler, a client island, and a `read()`-bound attribute placed
  *inside* a `match`/`when`/`each` arm keep working across a branch/list flip and
  subsequent live updates (Bug A).
- A `read()` text/attr binding *inside* an arm shows correct data on the **first**
  fan-out that activates the arm, matching a leaf binding for the same machine
  (Bug B).
- Regression coverage: a wire/SSE test that (1) puts an island + a `read()` inside
  a `match`, drives a `loading → ready` flip via an entry-effect completion, and
  asserts the island's attr patch targets the island and the arm's text patch
  carries fresh data.

## Constraints

- Fix must not change the initial-render HTML or the public template API
  (`match`/`when`/`each`/`read`/`on:`/islands stay as written).
- Element-id scoping must stay compatible with `wire/apply.ts resolveTarget`
  (element → `[data-stator-id=]`) and the client island registry.

## Approach

- **Bug A:** arm-scope element-id allocation to mirror slot-id scoping
  (`render-context.ts` id allocation + the arm scope stack in `conditional.ts` /
  `each.ts`); update `resolveTarget`/emit sites to the scoped id.
- **Bug B:** give `RenderState` a reference to the active runtime during
  recompute (set in `recompute` / `fanOut`), and make `read()` resolve the proxy
  via `proxyFor(def.name)` against that runtime when one is present, falling back
  to the passed instance for the initial render.
- Add the SSE regression test above; re-verify against `examples/weather` cold
  load (island scene + first-paint temp).

## Alternatives Considered

- **Document + error at build/dev time instead of fixing.** Rejected: the
  patterns are natural and the initial HTML is correct, so a build error would
  forbid legitimate templates. Both bugs have clean, mechanical fixes that keep
  the pattern working.
- **Fix only Bug B (the visible one).** Rejected: Bug A silently miswrites (can
  hit a real element with no warning), which is the more dangerous of the two.

## Open Questions

- Does arm-scoping element ids interact with any existing island that relies on
  a stable flat id across renders? (Audit island registry / `defineElement`.)
- Should `read()` warn (dev only) when it falls back to the closure instance
  because no runtime is on the `RenderState`, to catch future regressions?

## Implementation Notes

- Source evidence and live SSE captures are in `examples/weather/FINDINGS.md`
  (#2 = Bug A, #3 = Bug B). Both worked around there by keeping element-id'd
  nodes and data `read()`s outside conditional arms.
- Aside: `chisel spec list`/`index` currently panics on an em-dash byte-boundary
  (`packages/chisel-specs/src/lib.rs:313`) — unrelated to this spec, but worth a
  separate fix; `chisel spec new`/`view <slug>` still work.
