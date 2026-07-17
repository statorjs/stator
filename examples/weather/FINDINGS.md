# Findings — building the weather example

Framework rough edges surfaced while building this app (per CONTRIBUTING's
"findings over patches"). Each is worked around in the example; the note is for
the framework.

## 1. Static `class` + `class:list` on the same element emits two `class` attributes

`<button class="place-tab" class:list={{ active }}>` compiles to a tag with
**two** `class` attributes:

```html
<button class="active" ... class="place-tab">
```

Per the HTML parser the browser keeps the *first* and drops the rest, so the
static `place-tab` class silently vanishes.

- **Workaround:** put every class in `class:list` — it accepts an array mixing a
  static string with a conditional object: `class:list={['place-tab', { active }]}`.
- **Suggested fix:** merge a static `class` attribute into the `class:list`
  output (or emit a compile-time error/warning on the collision), since the
  duplicate is silent and surprising.

## 2. Element ids are a flat global counter, so an element-id'd node inside a `match`/`when` arm gets an unstable id

Slot ids are arm-scoped and stable (`s3:bready:s1`). Element ids (`data-stator-id`,
used for **attr patches**, `on:` handlers, and client islands) are a **flat
sequential counter**, so the id assigned to a node depends on how many
element-id'd nodes rendered before it — which differs between an incremental
branch-swap render and a full page render.

Concretely: a client island with a live `read()` attribute placed *inside* a
`match` arm got id `e0` in a full render but `e3` after a `loading → ready` branch
swap (the always-rendered nav buttons took `e0..e2` first). On a subsequent live
update, the attr patch targeted `e0` — which in the live DOM was a **button**, not
the island — so `setAttribute` landed on the wrong element and the island never
updated. Text/slot patches were unaffected (slot ids are arm-scoped).

- **Symptom:** an attribute bound with `read()` on an element inside a conditional
  silently stops live-updating (patch lands on the wrong node, or logs
  `patch target element "eN" not in DOM — skipped`).
- **Workaround:** keep element-id'd nodes (islands, `on:` handlers, `read()`-bound
  attributes) **outside** conditional arms. Here the live-sky was moved out of the
  `match` so only its overlay text is conditional.
- **Suggested fix:** scope element ids to the branch arm the same way slot ids are
  (`eN` → `s3:bready:eN`), so an element's id is stable regardless of surrounding
  conditional state.

## 3. A `read()` inside a `match`/`when` arm renders STALE on the first data arrival (fan-out re-render uses a frozen closure proxy)

Sibling of #2 — same theme (arm interiors are second-class on the live path),
different mechanism. This one is about **data**, not element ids.

A `read(machine, sel)` placed *inside* a conditional arm shows a stale value the
first time the arm's key flips as new data lands — e.g. a synchronous route with
an async `entry` effect: `match(status, { loading: …, ready: () => <b>{read(m, s
=> s.temp)}</b> })`. On the cold load, `ready` renders `—` (no data) even though
the data is present, then only corrects on the *next* unrelated update (a reload
or any other event that touches the machine).

**Why.** A live SSE connection keeps a long-lived runtime. When a mutation
happens in another runtime (a POST, or here an `entry`-effect completion),
fan-out **rehydrates** the connection's actor — `rehydrate()` builds a *new*
actor, **stops the old one**, and swaps in a *new* proxy (`session-runtime.ts`).
`recompute` then diffs:

- **Registered leaf bindings** (text/attr) are re-evaluated against the
  connection's *current* proxy (`conn.runtime.proxyFor(name)`) → **fresh**.
- **A re-rendered arm body** (branch key changed → `renderBranchBody` →
  `renderer()`) runs the arm's JSX, whose nested `read(m, sel)` uses the
  **render-time closure's** machine proxy — bound to the now-*stopped*
  connect-time actor, frozen at pre-data state → **stale**.

So in one fan-out, a leaf binding and an arm-interior binding for the *same
machine* disagree: an attr `read()` at the top level updated to live data while a
`read()` inside the arm rendered the no-data placeholder. Once the arm renders,
its interior `read()` *becomes* a registered leaf binding, so the next recompute
fixes it — which is why "reload or trigger any other event" heals it.

- **Symptom:** data bound via `read()` inside a `match`/`when` arm shows the
  empty/placeholder value on the first render where the arm becomes active due to
  fresh data; corrects on the next update. Leaf `read()`s outside arms are fine.
- **Workaround:** keep data `read()`s **outside** conditional arms (stable leaf
  bindings recompute keeps fresh); let the conditional toggle only static
  content (a message/label with no nested `read()`). Here temp/cond were pulled
  out of the `match`, which now only swaps the loading/error message.
- **Suggested fix:** during a recompute-driven arm re-render, resolve nested
  `read()` proxies from the *current* render context's runtime (by machine name)
  rather than trusting the closure-captured instance — e.g. stash the fan-out
  runtime on the `RenderState` so `read()` looks up `proxyFor(def.name)` freshly.
  Then arm interiors and leaf bindings always agree.

## 4. Static attributes on a component/island's *root* element are dropped

The root element of a component/island definition loses every static attribute
it's authored with. `templates/tile-motion.stator` whose root is
`<tile-motion hidden title="probe" data-probe="p">` renders to the DOM as a bare
`<tile-motion>` — all three dropped. Same for the live-sky island: its root
`<live-sky class="live-sky">` reaches the DOM as `class=""`.

Only **usage-site** attributes survive: `<LiveSky scene={…} />` correctly puts
`scene` on the element, but the definition's own `class="live-sky"` is gone. So
a component can't carry its own base class, its own `hidden`, its own ARIA, etc.

- **Symptom:** styling/behaviour you hang off a component's root class (or a
  `hidden`/`role`/`data-*` on it) silently doesn't apply, because the attribute
  never reaches the DOM.
- **Workaround:** don't rely on the root's own static attributes. Style islands
  via a **tag selector** (`tile-motion { display: none }`, `.sky-tile .sky-canvas
  { … }`) instead of a root class, and set anything essential either at the usage
  site or from the island's `connectedCallback` (`this.classList.add(...)`).
- **Suggested fix:** merge the definition-root's static attributes with the
  usage-site attributes (usage wins on conflict, class/style *concatenate*)
  rather than replacing wholesale — the same merge `class` + `class:list` needs
  in #1. This and #1 are the same underlying gap: attribute **composition** on an
  element is "last writer wins / silently drop" instead of a real merge.

## 5. A non-keyed `each` re-renders wholesale on *every* transition of its machine

A `session` machine's context is `structuredClone`d per transition (by design).
So an array selector like `w => w.places` returns a **new array of new object
references** after *every* event — even one that never touched `places`. A
non-keyed `each` diffs by reference (`arrayShallowEqual`, element-wise `===`),
so it concludes "changed" every time and re-renders the entire list body.

Observed: `TOGGLE_CLOCK` (touches only `Settings.clock`, mirrored into
`Weather`) emitted a full `html` re-render patch for the location strip, which
never changed. Beyond the wasted work, a full list re-render **reallocates the
element ids** of everything inside it (the flat counter — #2), so `on:` handlers
and bound attrs inside list items churn ids on unrelated events.

- **Symptom:** every list re-renders (one `html` patch) on any event to its
  machine; the strip flickers/rebuilds and inner element ids shift each time.
- **Workaround:** give `each` a `key` — `each(items, fn, { key: (i) => i.id })`.
  The keyed path diffs by key, so retained rows keep their DOM (and ids), and
  only genuine add/remove/move emits per-item ops. Applied to the Pivot: after
  keying, `TOGGLE_CLOCK` → 0 list patches, `SET_ACTIVE` → 2 clean `class`
  patches (not a full rebuild).
- **Suggested fix / decision:** at minimum document "key your lists" loudly (it's
  the difference between O(1) and O(n) per event). Better: have the non-keyed
  `each` fall back to a *structural* (value) compare so an unchanged-content
  array doesn't re-render just because clone changed its identity — the whole
  point of the clone is that content, not identity, is canonical. Related to the
  "Where data lives" perf story in ROADMAP.

## 6. (Enhancement idea) First-class SVG icon handling

Rendering weather glyphs in the forecast rows meant hand-writing SVG in a lib
helper and injecting it with `raw()` (an unescaped sink) per row. It works, but
there's no ergonomic, safe story for "use an icon" in a Stator app — every
icon is bespoke inline SVG or a `raw()` string.

- **Idea:** an [`astro-icon`](https://github.com/natemoo-re/astro-icon)-style
  approach — an `<Icon name="…"/>` primitive backed by a local icon dir and/or
  icon sets, resolved and inlined at build/render time (so it's server-rendered,
  cacheable, tree-shaken, and never ships a runtime sprite fetch). Server
  rendering has real challenges (the astro-icon author knows them well) but
  Stator's compile-time template lowering is a good fit.
- **Why:** icons are universal; today the only paths are inline SVG (verbose) or
  `raw()` (unsafe by default). A first-class primitive removes both papercuts.
- Not a bug — a DX gap worth a design pass. (Raised while building the weather
  example's hourly/daily forecast glyphs.)
