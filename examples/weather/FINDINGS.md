# Findings — building the weather example

Framework rough edges surfaced while building this app (per CONTRIBUTING's
"findings over patches"). Each is worked around in the example; the note is for
the framework.

**Status:** #1–#4 (composition-boundary bugs) shipped in #20; #5 (per-row item
bindings) shipped in #24. The rest remain open enhancement notes. This file is
transient scratch — durable records live in `.chisel/specs/` and `ROADMAP.md`.

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
- **Resolution (per-row item bindings via `read(item, …)`):** an item field is made
  live by reading it from the row — `read(item, (i) => i.field)` — the same `read()`
  marker used for machine state. The compiler lowers that to a per-row `itemBind`
  re-evaluated against the current item on recompute: a content change patches just
  that field (`text` op, row DOM/ids/islands preserved), and identity churn no longer
  re-renders (values compared, not references). Covers **both** non-keyed and keyed
  (per-key, stable across moves) lists — so the keyed static-capture staleness above
  is fixed too, not only the churn. A plain `{item.field}` still renders once, so the
  "`read()` is the unit of reactivity" doctrine holds. Full design:
  [`.chisel/specs/active/per-row-item-value-bindings-in-each.md`](../../.chisel/specs/active/per-row-item-value-bindings-in-each.md).
  - **DX payoff (validated):** the `read(m, m => m.coll.find(x => x.id === item.id)?.f)`
    workaround this finding forced collapses to `read(item, i => i.f)` — shown in
    todomvc and live-poll; the same shape recurs in the desksmith cart and with-auth
    notices.
  - **Deferred:** `read(item, …)` in *attribute* position (`class={…}`, `checked={…}`)
    — text-only for now; `raw(item.icon)` item-html; and the unkeyed all-static churn
    case (a whole-array value compare would close it).
  - **Semver:** minor. A live item field renders inside a `<span data-slot>` (as
    `read()` already does) — new markup, same content.
  - **Note:** first built as implicit `{item.field}` reactivity, then reworked to
    explicit `read(item, …)` — the implicit form made a bare `{expr}` live with no
    marker (off-doctrine) and needed a `raw`/nested-`each` guard against silent
    staleness; the explicit form drops both.

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

## 7. Dev inspector's flash masks the very change it highlights

Toggling °C/°F felt laggy: the temperatures updated instantly but the pressed
unit button didn't visibly highlight for ~300ms. Instrumenting the wire path
ruled out the framework — 56 patches applied in **1.0ms**, full round-trip 25ms.
The delay was the **dev inspector**, and specifically its element flash.

- **Root cause:** `client/inspector.ts` flashed each patched element by animating
  `background-color` in a 1.2s `@keyframes`. A CSS animation's `background-color`
  is a higher cascade origin than any normal author rule — it overrides the
  element's own `background`, including `.u-btn.active { background: … }`, for the
  animation's whole duration. So a patch that lights up a button's background was
  masked by its own flash. `text` patches were unaffected (text sits above the
  tint), which is exactly why content looked instant but the background-based
  highlight lagged. Class *order* (`stator-flash--attr` vs `active`) is a red
  herring — animations beat normal rules regardless of selector specificity or
  order, so no app-side reorder/`!important` can win.
- **Fix (prototyped locally, not yet landed):** flash with an **outline** only
  (painted outside the box, masks nothing); never animate `background-color`. A
  working prototype is in `packages/stator/src/client/inspector.ts` — to be
  landed with a regression check during the findings pass, together with (a)–(c).
- **Longer-term (raised, not yet designed):**
  - **Style isolation.** The inspector injects global CSS (`.stator-flash`, …)
    straight into the page, so its dev-only styles can collide with app styles —
    this bug was that collision. A dev overlay reaching into app elements' own
    paint is the smell. Options: a shadow-DOM host, a low-priority `@layer` so app
    styles always win, or a non-intrusive highlight technique (overlay layer)
    that never touches the target element's box.
  - **Styles-as-string.** The inspector's CSS lives in one large template-literal
    `STYLES` constant — no tooling, no isolation, easy to introduce exactly this
    kind of bleed. Worth revisiting how framework-owned UI ships its styles.
- Note: `bundleInspector()` builds once at app-creation and caches, so iterating
  on the inspector needs a dev-server restart (no HMR for the asset).

## 8. `read()` selector callbacks show red in the editor (unconfirmed cause)

In `.stator` templates, `read(weather, (w) => w.panelForId(id).temp)` shows a lot
of red in the editor — `w` appears to lose the machine's selectors. **Cause not
yet pinned** — and importantly, the obvious hypotheses are *disproven*, so this
needs the actual error before anyone "fixes" the wrong thing:

- **NOT `read`'s generic signature.** The theory was that
  `read<TDef extends AnyMachineDef>(instance: InstanceOf<TDef>, …)` can't infer
  `TDef` because `InstanceOf` is a conditional type (non-invertible). A faithful
  `tsc` repro (TS 5.9.3) says otherwise: it infers `TDef = WeatherMachine` and
  `w` keeps its selectors — **type-checks clean**. (Repro shape: `MachineDef`
  with `Sel extends Record<string,(...)=>any>`, selectors as `(ctx)=>value`
  where a parameterized one returns a function, `Stator.reads` as a mapped
  tuple.)
- **NOT `defineMachine` erasing selectors.** It returns
  `MachineDef<C, E, S, Sel, Name>` — `Sel` is preserved.
- **NOT the LSP importing a different `read`.** `compiler/virtual-code.ts`
  injects the real `read` from `@statorjs/stator/template` and declares
  `Stator.reads` with the real template `InstanceOf`.
- **Tracked down — not a code bug.** Generated the *exact* virtual TSX the
  language-server type-checks (`toVirtualCode` from `@statorjs/stator/compiler`,
  the same call at `language-server/src/language-plugin.ts:100`) for both a
  component (`uv-tile`) and the route (`index`), and ran it under TS **5.6, 5.7,
  5.8, and 5.9** with the example's real tsconfig: **zero errors every time**. So
  `read` inference, `InstanceOf`, the real machine `SelectorMap`, and the vtsx
  generation are all fine. Also confirmed `.stator/types` exist and
  `@statorjs/stator/*` resolves to source (no dist-build dependency).
- **Localised to editor state, not the framework.** The red is an editor-side
  toolchain issue. Most likely a **stale TS/Stator language-server program** —
  this session churned many files (the whole component refactor), and a running
  language server can serve pre-refactor diagnostics until restarted. The bundled
  `language-server/dist/server.cjs` was also one commit stale (missing `defer`);
  **rebuilt** it to be safe.
- **Closed (confirmed):** a language-server restart + window reload cleared the
  red. It was stale editor state, not a code defect. (If it ever recurs on a
  *clean* restart, the exact hover text on `w` — "cannot find module
  `@statorjs/stator/template`" (resolution) vs "property `panelForId` does not
  exist" (type) vs "implicitly `any`" (inference) — would point at a real bug.)

## 9. Components can't own reads → shared state is prop-drilled

Splitting `index.stator` into tile components surfaced that `Stator.reads` is
route-only (`compile.ts:361`); a component receives the machine *handle* as a
prop (`<UvTile weather={weather} placeId={p.id} />`) and does its own
`read(weather, …)`. **Validated** end-to-end — the extracted tile's reads
produce per-panel scoped slots and patch live (UV filled to `6` the moment the
route's hero filled to `17°`).

Route-only reads is the *right* default (loading is a setup-phase concern;
reads are the capability surface; data-down keeps components reusable). But it
prop-drills **state** through every layer, which is real DX friction at scale,
and a forgotten prop is a *runtime* error. The fix — read machines by their
imported def from the ambient request context, with the dependency carried in
the type and enforced up the tree (inversion of control) — is designed in
[`ambient-by-def-machine-reads-with-a-typed-requirement-channel`](../../.chisel/specs/active/ambient-by-def-machine-reads-with-a-typed-requirement-channel.md)
and tracked in [ROADMAP.md](../../ROADMAP.md) under Primitives. Until it lands,
the refactor uses the `weather={weather} placeId` contract.

## 10. `this.attrs.X` on a client island is typed `unknown`

`static attrs = { scene: String }` declares the observed attributes and coerces
each one (kebab DOM attr → typed value), but `StatorElement`'s instance getter is
`get attrs(): Record<string, unknown>` (`packages/stator/src/client/element.ts:63`).
So `this.attrs.scene` is `unknown`, and any use needs a cast
(`this.attrs.scene as string`) — TS(2345) otherwise. The `${key}Changed(next)`
callback is fine (the author types `next`); only the direct `this.attrs.X` read
loses the type the declaration already implies.

- **Why it's hard:** a base class can't infer the instance `attrs` shape from a
  subclass's `static attrs` field without generics.
- **Options:** a generic base (`class LiveSky extends StatorElement<{ scene: string }>`),
  or a declaration helper that maps the `String`/`Number`/`Boolean` constructors
  in `static attrs` to `string`/`number`/`boolean` on `this.attrs`.
- Worked around in the example with `as string`. (Surfaced by `live-sky`.)
