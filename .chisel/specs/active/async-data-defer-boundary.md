---
title: 'Async data in synchronous routes: the defer boundary'
status: draft
created: 2026-07-14
updated: 2026-07-14
area: runtime
---

## What and Why

Frontmatter/render is synchronous — a permanent contract. It's what keeps
live-page diffing coherent (fan-out re-evaluates binding selectors
synchronously), and it's what keeps the session lock off I/O (the `/__events`
re-diff render runs *under* the lock). The cost of that contract: `await
db.query()` / `await fetch()` has no home on a page. A synchronous source works
today — `with-auth` reads `node:sqlite` straight from a guard — but any async
source is a wall. This is the one gap where a first-hour evaluator hits a dead
end instead of a workaround (gap analysis #1).

This spec resolves it **without touching the sync contract**, by adding one
template construct — `defer` — that marks an async region the framework resolves
*outside* the synchronous render, and by drawing a firm line between it and the
reactive/machine path.

### Decisions locked (design discussion, 2026-07-14)

- **Frontmatter is synchronous, forever. No `await` in frontmatter, no
  exceptions.** (See "Alternatives" for why not even "await only our helper.")
- **Two doors for async data, chosen by whether it's reactive:**
  - **`defer(fn, {...})`** — view-scoped, one-shot, per-request async (a product
    page's data, a "your orders" list). *This spec.*
  - **Machine `loading → ready | error` states** — reactive, stateful, shared
    async (a live feed, live inventory). Kicked by **entry effects** (sibling
    primitive, its own spec — it also unlocks `after`/state-timeouts), delivered
    live over SSE. Referenced here, not built here.
- **v1 ships simple: no streaming.** `defer` resolves its data *during the
  request* and renders complete HTML inline. No placeholder ever reaches the
  browser. Placeholder-and-stream is the designed-in, non-breaking upgrade path.
- The peekable-resource + stable-slot-id + resolve-window machinery ships in v1
  even though streaming doesn't, so the upgrade is purely additive.

## The surface (v1)

`defer` is a template construct (text position, like `each` / `when` / `match`).
It takes a thunk that returns the data (sync value or promise) and an arm map;
it returns a fragment rendered inline once the data resolves.

```
---
import Auth from '../machines/auth.ts'
const [auth] = Stator.reads([Auth])
const { id } = Stator.request.params
---
<main>
  {defer(() => db.getProduct(id), {
    ready: (product) => <ProductView product={product} />,
    error: () => <NotFound />,
  })}

  {defer(() => db.getOrders(auth.userId), {
    ready: (orders) => <OrderList orders={orders} />,
    error: (err) => <p class="err">Couldn't load your orders.</p>,
  })}
</main>
```

Semantics:

- The thunk is **not** run during the synchronous render pass — it's positioned
  in the template, so it closes over frontmatter locals (`id`, the `auth` proxy)
  and the framework invokes it in a resolve phase *after* the sync render.
- **v1 blocks-inline:** the framework kicks every `defer` thunk during the sync
  render, then awaits all of their resources **in parallel** (a page with three
  defers waits for the *slowest*, not the sum), then fills each slot with its
  `ready(value)` / `error(reason)` result, then flushes complete HTML.
- `error` is optional; absent, a rejection bubbles to route-level error handling
  (500 / route error boundary). A `ready` thunk receiving `null`/`undefined` is
  the author's to handle (e.g. render `<NotFound/>`).
- **Arms may set response status/headers.** Because v1 resolves *before* flush,
  a not-found `defer` can legitimately `Stator.response.status = 404`. (This is a
  genuine advantage of the blocking model that streaming gives up — once a shell
  is flushed 200, you can't change the status. Noted as a reason the v1 model is
  good on its own terms, not just a stopgap.)
- The thunk runs **off the session lock** (the initial render happens on the
  GET / SSE-connect path, neither of which holds the lock). See "Lock &
  re-diff."

The `~20ms` tradeoff (accepted for v1): the response waits for the sync route
render plus the resolve window (a tick for already-ready data; longer for a
genuinely-cold source). If a slow `defer` blocking the whole response becomes a
real complaint, streaming (below) is the escape valve — added without changing
author code.

### Guidance: put the fetch in the thunk, not the frontmatter (the Astro trap)

Do the async work **inside** the `defer` thunk. Don't create the promise as a
frontmatter const and hand it in:

```
// ANTI-PATTERN — the kick is un-gated and re-fires on every render
---
const data = Promise.all([api.fetchProducts(), api.fetchReviews()])
---
{defer(() => data, { ready: ([p, r]) => … })}

// DO THIS — the framework owns the kick
{defer(() => Promise.all([api.fetchProducts(), api.fetchReviews()]), {
  ready: ([p, r]) => …,
})}
```

Creating the promise in frontmatter is *legal* — it's a synchronous call, not an
`await` — but then the kick is a bare frontmatter statement, which runs on
**every** execution of the render function, including every `/__events` baseline
re-render (each `on:click` re-runs the frontmatter under the session lock to
rebuild the diff). So the fetch re-fires on every interaction; the framework
can't gate it (it only recognizes a `defer()` call as a skippable/memoizable
seam, not an arbitrary const); and the results are discarded (the defer slot is
static, skipped on re-diff) — wasted duplicate load on your API. Inside the
thunk, the framework fires it only on a cold render, memoizes it against the
slot id, and skips it on re-diffs. Passing a pre-made promise (`() => data`) is a
thunk in form but not in effect: the kick already happened.

**The Astro trap.** Devs arriving from Astro (or any top-level-`await` SSR
framework) reach for `const data = await fetch(...)` in frontmatter, and when
that's rejected, for `const data = fetch(...)` + `defer(() => data)`. Both belong
in the thunk here — frontmatter is synchronous *setup*; `defer` is where a
per-request fetch lives. The docs recipe should lead with this contrast.

Parallelism doesn't motivate the frontmatter form either: separate `defer`
blocks kick their thunks in parallel during the sync pass and await together.
Sharing one fetch across several `defer` slots is the one thing a frontmatter
const uniquely expresses — and it has the same re-fire problem — so shared data
belongs in a machine (app/session) or a request-scoped cache, not a frontmatter
promise.

## Internals: the peekable resource + resolve window

**Why a resource, not a raw promise.** You cannot synchronously read a native
promise's settled state — `.then` is always a microtask. So `defer` wraps the
thunk's result in a **resource**: a thin wrapper recording
`{ status: 'pending' | 'fulfilled' | 'rejected', value | reason }` as the
promise settles. "Peeking" is reading `resource.status` synchronously at
fill-time. (Same shape as Solid `createResource` / React `use`+cache / Vue async
resource.) A thunk that returns a non-promise fulfills the resource immediately —
so `defer` degrades to plain inline render for sync data.

**Stable slot id.** The compiler assigns each `defer` block a stable slot id (as
it already does for bindings), so its resource is memoized per render-lifecycle
and its slot is addressable for a future stream/patch.

**The resolve window (avoids placeholder flash for already-ready data).** Within
one synchronous render, a promise kicked *during* that render can never settle
(run-to-completion; microtasks don't interleave). So the sync render can only
ever see `pending`. The fix is a short window *between* the sync render and the
fill pass:

1. Sync render kicks every `defer` thunk (creates resources), reserves holes.
2. Yield **one event-loop tick**. Everything already-ready settles here —
   sync values, warm caches, already-resolved promises, dedup'd work that
   finished earlier. Real network/disk I/O does **not** settle in a tick.
3. Fill pass: peek each resource; call `ready`/`error`; splice inline.

In v1 (no streaming) the window and the block are the same phase — the framework
simply awaits all resources (bounded by the slowest) before the fill pass. The
window matters most as the *seam* streaming will use: when streaming lands, the
window is where "already ready ⇒ inline, no placeholder" is decided, so fast data
never flashes a placeholder it's about to replace.

Precise drain (a single microtask vs a `setTimeout(0)` macrotask yield that
flushes multi-hop-but-instant chains without waiting on I/O) is an
implementation detail, not a design fork.

## Lock & re-diff (why defer stays off the lock)

`renderRoute` gains an async resolve phase, so it becomes async — fine on the GET
and SSE-connect paths (no lock held). The danger is the `/__events` baseline
re-render, which runs under the session lock: re-running a `defer` thunk there
would await I/O under the lock.

It doesn't, because of one guardrail: **a `defer`'s resolved value is static —
it can only appear in static template positions, never inside a `read()`
selector.** (If you need the value to drive a live binding, it belongs in a
machine — the reactive door.) The `/__events` re-diff only computes patches for
bindings, so it never needs a `defer` slot's content and therefore never
re-runs its thunk. Net: `defer` I/O happens only on the initial render, off the
lock; the dispatch path leaves `defer` slots untouched. On a live connection the
resource is already warm from the initial render, so a peek is cheap and
consistent; on a non-live page the dispatch path simply doesn't touch the slot.

## Path forward: streaming (deferred, non-breaking)

When blocking on a slow `defer` becomes a real complaint, add — additively — an
optional `pending` arm and a per-boundary deadline:

```
defer(() => api.recommendations(userId), {
  pending: () => <Skeleton />,          // NEW: shown if the deadline is missed
  ready:   (recs) => <Recs items={recs} />,
  error:   (err) => <RetryNotice reason={err} />,
  wait:    30,                          // NEW: ms to wait before falling back
})
```

- A boundary that settles within the resolve window / `wait` → inline, as v1.
- A boundary still pending after `wait` → ship the `pending` placeholder now and
  **stream** the resolved (or errored) fragment into the slot when it lands.
- Delivery backends behind capability detection:
  - **SSE patch** into the slot (reuses the existing wire `html`/slot ops).
  - **Native Declarative Partial Updates** — a `<?marker name="slot">`
    placeholder + a later `<template for="slot">` streamed into the *same*
    response, swapped natively with no client JS. (Chrome 148, Experimental Web
    Platform Features flag; Stage 2 WHATWG / WICG explainer as of 2026-07.
    Not universal — a progressive-enhancement backend, not a dependency.)
- In streaming mode a page with a still-pending `defer` needs the delivery
  channel open, so **`defer` implies `live`** *only under streaming*. In v1
  (blocking) there is no such implication.
- **Stateful retry stays out of `defer`.** Re-fetch-and-remember, backoff, a
  persistent "retrying…" is a machine (`loading → ready | error` + a `RETRY`
  event). `defer`'s `error` arm may offer a one-shot re-kick, but anything that
  must survive graduates to the reactive door.

## Relationship to the reactive path

`defer` is deliberately the *static / one-shot / view-scoped* door. Its twin —
reactive, stateful, shared async — is a machine with `loading → ready | error`
states, whose fetch is kicked by an **entry effect** (fire an effect on entering
a state, including initial hydration) and whose updates stream live over SSE.
That entry-effect primitive is a separate spec; it is **not** a dependency of
`defer` v1 (a `defer` kicks its own thunk). The two share one delivery substrate
once streaming lands (slot patches over SSE / Declarative Partial Updates), and
one rule keeps them from overlapping: **if the value must update after first
render, it's a machine; if it's fetched once for this view, it's a `defer`.**

## Alternatives Considered

- **`await` in frontmatter (Astro-style).** Rejected. The `/__events` re-diff
  runs under the session lock, so a frontmatter `await` holds the lock across
  I/O — the exact footgun the effect model avoids. And allowing `await` on only
  a special helper is a false affordance (people will reach for `await fetch`).
  So: no `await` in frontmatter at all; async is a declared boundary the
  framework runs off the sync timeline.
- **A pre-render `load()` export / `Stator.load()`.** Rejected as the shape.
  `load()` is magic-export-by-convention (or, as `Stator.load`, a foreign
  blocking-loader concept); it also can't close over frontmatter locals. `defer`
  gives the same "data before paint" as an in-body construct with no export, and
  is the streaming boundary from day one.
- **Pure `match(state)` on a machine, no dedicated construct.** Correct for the
  reactive path, but `match` is a generic state switch — the framework can't
  tell a streamable async boundary from an ordinary branch. `defer` is that
  marker, which is what makes the native-streaming upgrade mechanical.
- **Name.** Chose `defer` over `suspense` (React client-suspend baggage;
  describes *waiting to render*, the opposite of "render fallback, stream real")
  and `partial` (mirrors the native "partial updates" name but overloaded with
  template partials). `defer` matches the actual mechanic and has server-stream
  lineage (Remix `defer`/`<Await>`).

## Tooling: enforcing synchronous frontmatter (and an LSP scoping note)

The sync-frontmatter contract needs to be *enforced*, or the whole `defer`
story leaks: an author who writes `await db.query()` in frontmatter must get a
clear "move this into `defer(…)`" error, not silent surprising behavior.

**Current gap (found 2026-07-14).** `await` in frontmatter is *not* flagged in
the editor today. The runtime `compile()` emits the frontmatter body inside a
synchronous function (where `await` would be TS1308), but the language server
uses a *separate* emitter — `compiler/virtual-code.ts` `buildServerTsx` — which
places the executable body at **module scope**, and top-level `await` is legal
in an ES module. So the two emitters disagree on scope, and TS stays silent.

**This is a latent class, not a one-off.** The module-vs-function-body gap also
mis-models `return`, top-level `this`, `using`, `import.meta` in frontmatter —
same failure shape (fine in the editor, different at runtime). It matters more
as frontmatter grows (this spec's `defer` adds real frontmatter/template
interplay).

**The module-scope choice isn't principled.** Its stated reason ("so the
template sees the frontmatter's bindings", `virtual-code.ts:134`) holds equally
if the body sits *inside* the same `export default function` as the template
`return` — same scope, same visibility. The real driver is v1 mapping
simplicity (one contiguous source→generated run vs a hoist/body split).

**Decision: converge, don't just guard.** Align the LSP emitter's scoping onto
the runtime's — hoist imports/type/interface decls to module scope, emit the
executable body inside `export default function (_props: PropsType) { <body>;
return (<>…</>) }`. This makes `await` (and `return`, `this`, …) native TS errors
— killing the whole class, not one symptom — while keeping the intended emitter
difference (JSX-for-intelligence vs `html` for execution) and staying compatible
with prop-checking and binding resolution.

- **Risk to watch:** the source→generated mappings are the load-bearing part;
  they go from one contiguous run to a hoist/body split (clean for the common
  "imports first" layout, messier if imports interleave with statements). Gate
  the change on `compiler-virtual-code` / `virtual-code-typecheck` tests plus new
  "await/return in frontmatter now errors, and hover/completion still land" cases.
- **Fallback if convergence gets too hairy:** ship a compiler async-guard — a
  `CompileError` on a frontmatter `AwaitExpression` with a "move it into
  `defer(…)`" message (surfaced in-editor via the `stator-diagnostics` service,
  in dev via the Vite overlay, and at build) — and record the module-scope
  divergence as tracked debt to revisit before frontmatter grows further.
- **Either way**, a friendly compiler-level message beats the generic TS1308, so
  the async-guard is worth keeping as message polish even after convergence.
- `.then`/`.catch` and floating promises are belt-and-suspenders (they don't
  block or hold the lock the way `await` does) and are best done type-aware in
  the LSP layer, where the checker can confirm a Promise-typed receiver and avoid
  false positives. Lower priority than the `await` class.
- Same LSP family: a Promise-typed frontmatter const flowing into a `defer()`
  thunk (`const data = fetch(…)` → `defer(() => data)`) — nudge "move the call
  into the thunk so the framework gates it" (see the Astro-trap guidance above).
  A lint, not an error; the pattern is legal, just un-gated.

## Open Questions

- Exact resolve-window drain: single microtask vs `setTimeout(0)` macrotask
  yield. (Impl detail; `setTimeout(0)` catches multi-hop-instant chains.)
- Whether v1 should bound the block with any deadline at all. Leaning **no** —
  block until resolved (a page is as slow as its slowest query, like every
  loader-based SSR framework) — since without streaming there's nothing to fall
  back *to*. Revisit when streaming lands.
- Compiler surface: `defer` needs to be recognized so the render pass can kick
  thunks and the framework can run the resolve phase (renderRoute → async).
  Confirm it composes with `each`/`when` nesting.
- Enforcement of "defer value is static, never `read()`" — compile-time error vs
  lint. Compile-time preferred (it's what keeps defer off the lock).

## Success Criteria

- A `.stator` page fetches from an async source with **synchronous frontmatter**
  and no `await`, rendering complete HTML.
- Already-ready / sync / warm-cache data renders inline with no added latency and
  no placeholder.
- A `defer` thunk never runs under the session lock, and the `/__events` re-diff
  never re-runs it.
- Response status/headers can depend on a `defer` result (e.g. a 404).
- Adding streaming later (optional `pending` + `wait`) requires **no change** to
  an existing `defer` call.
