---
title: Client scripts, directives, and isomorphic machines
status: ready
created: 2026-06-16
updated: 2026-06-17
area: compiler
---

## What and Why

Stator's thesis is "DOM renders where its state lives." That is *almost* always
the server, which is why the framework is server-canonical. But the rule is the
axiom; server-canonical is the consequence. Some state legitimately lives only
in the browser — whether a dropdown is open, which tab is active, the text in a
field before it's submitted — and forcing it through the server is a pointless
round-trip that degrades on a flaky connection.

This spec defines how client-only state and behavior are expressed in a Stator
single-file component, and it does so as a contained extension of the model the
runtime already has — not a second framework bolted onto the side. It depends on
the `.stator` SFC format and compiler (see
[[v1-compiler-against-real-templates]]) and on the planned custom state-machine
engine that replaces XState.

The hard requirement that shaped every decision below: **it must be simple and
obvious, from the source alone and with no editor tooling, when code leaves the
server and runs in the browser.** The explicit anti-goal is the React Server
Components failure mode — file-level coloring, viral transitivity, boundaries
invisible at the call site, and breakage that only shows up at runtime. Clarity
of the boundary is treated as a make-or-break property of the whole feature.

## Success Criteria

- Reading an SFC's source, with no LSP or syntax highlighting, makes it
  unambiguous which code runs in the browser.
- A reactive client-only counter (state rendered to the DOM, updated on click,
  never touching the server) can be written end-to-end in one SFC.
- The same machine definition can be used server-side in one component and
  client-side in another, with no change to the definition.
- A machine that touches a server-only capability (Store, secrets, cross-session
  emit) is a **compile error** if placed on the client, and the error names the
  offending capability.
- No JSX / template re-execution ships to or runs in the browser. Client DOM
  updates are native DOM operations.
- The four example templates and the existing runtime continue to work; this is
  additive.

## Constraints

- **One mechanism for the boundary: import location.** A machine (or any module)
  imported in the SFC frontmatter fence runs on the server; the same imported
  inside a `<script>` block runs in the browser. There is no `lifecycle: 'client'`
  flag, no `"use client"`, no `Stator.client()` wrapper, and no second way to say
  it. The `<script>` block is the labeled client region; its import list is its
  client dependency manifest.
- **The machine definition is location-agnostic (carry-over of the existing
  model).** Location is a use-site decision, never a property of the definition.
  This is what lets the same machine be server here and client there. Contrast
  with RSC, which colors the file.
- **No JSX on the client.** There is no client-side rendering engine and no
  client recompute. The server renders everything it can; the browser mutates the
  already-rendered DOM with native APIs. Client DOM *creation* is allowed but only
  via native primitives — `<template>` cloning, `createElement`, `innerHTML`,
  custom elements — never by re-running the component's JSX.
- **One reactivity model.** Reactive state is a machine, on both sides of the
  boundary. The server's `read(machine, selector)` and the client's `bind:`
  directive are the two faces of the same primitive ("declare on a node what state
  it shows"). Plain class fields are a deliberately *non-reactive* escape hatch.
  Helpers that wire DOM to state must be thin, explicit sugar over native DOM
  operations — never a hidden renderer.
- **DOM-coupled wiring lives on the node it couples to.** Events in (`on:`) and
  state out (`bind:`) are declared on the element. Reactions that are *not* a
  simple node binding fall back to a named convention method or `effect()`.
- **The compiler verifies; it does not infer placement.** Client/server placement
  is always written explicitly by the developer (via import location). The
  compiler only *checks* legality (capability portability, ref existence, key
  existence) and *surfaces* a per-page manifest. Nothing silently moves across the
  boundary.

## Approach

### The boundary: the `<script>` block + import location

An SFC has three regions: the frontmatter fence (`---`, server), the template
body (server-rendered), and an optional `<script>` block (browser). What an
import means is determined by which region it sits in:

```
---
import type CounterMachine from '../machines/counter.ts'   // server: type-only ref
---

<counter-widget>
  <button on:click={increment}>
    Count: <span bind:text={count}></span>
  </button>
</counter-widget>

<script>
  import { machine } from '@statorjs/stator'   // imported here ⇒ client

  // component-local reactive state — inline, no separate file
  const Counter = machine({ count: 0, on: { INCREMENT: (s) => { s.count += 1 } } })

  export default class {
    counter = use(Counter)             // client actor, owned by this element
    increment() { this.counter.send('INCREMENT') }
  }
</script>
```

To know what runs in the browser, you read the `<script>` block. That is the
entire rule.

### Directives on nodes

- **`on:<event>={handler}`** — generalizes the POC `on:` directive (which was
  locked to a single `machine.send()`). The handler's referent decides where it
  runs: a method on the client element or a send to a client machine runs locally;
  a send to a *server* machine goes over the existing `/__events` wire. One
  directive, three destinations, disambiguated by what the handler closes over —
  the same import-boundary rule.
- **`bind:<target>={stateOrSelector}`** — declarative "this node reflects this
  state," declared on the node. The target name encodes the write mechanism so the
  directive is declarative without being opaque:
  - `bind:text` → `textContent`, `bind:html` → `innerHTML`
  - `bind:value` / `bind:checked` → form-control value/checked (**two-way**)
  - `bind:disabled`, `bind:hidden`, `bind:<attr>` → attribute/property
  The bound target may be a context key or a machine selector (for formatting /
  derived values), mirroring server `read(machine, selector)`.
- **`ref:<name>`** — a server-rendered node addressable from the client script as
  `refs.<name>` (or `this.refs.<name>` inside a custom element). Replaces
  stringly-typed `querySelector`; the compiler injects a unique key at render and
  type-checks the reference (a `<button ref:btn>` yields `refs.btn:
  HTMLButtonElement`). `bind:` subsumes `ref:` for display-only nodes; `ref:`
  remains for nodes manipulated imperatively (focus, measure, third-party widget
  mount).

### `bind:` is the client mirror of `read()`

- Server: `<span>{read(counter, c => c.count)}</span>` → slot binding, `recompute`
  diffs, wire patch, native DOM apply.
- Client: `<span bind:text={count}>` → local subscription, engine diffs, native
  DOM write.

Both declare the same thing on the same node and compile to subscribe-and-write;
they differ only in server (recompute→wire→patch) vs client (local→DOM). Because
the compiler can read a machine's static initial context at build time, a single
`bind:` drives **both** the server's initial paint and the client's subsequent
updates — so the bound node needs no separately-rendered initial value.

### Form bindings (two-way)

`bind:value` / `bind:checked` are two-way, and one ownership rule keeps two-way
safe: **two-way binds to client state only.** A client machine holds the
uncommitted draft (live, local, every keystroke, no network); a server machine
holds the committed value; crossing between them is an explicit `dispatch` to a
server machine over the existing `/__events` wire. You never two-way-bind an input
to server state — that would put the network in the typing loop. Binding an input
to server state is one-way display (server renders/patches the value) plus an
explicit `on:` commit. Rule of thumb: **two-way is only as safe as it is local.**

`bind:value` is **sugar** that desugars to a state-to-DOM write plus a DOM-to-state
listener, and is ejectable to the explicit pair when you need custom commit
timing, coercion, or validation:

```
<input bind:value={query}>
=>
<input value={query} on:input={e => draft.send({ type: 'SET_QUERY', value: e.target.value })}>
```

The generated wiring owns the correctness details so they aren't hand-rolled:

- **Loop break / cursor preservation.** The state-to-DOM write is suppressed when
  `el.value === format(newValue)`. The keystroke sets `el.value` first, so the echo
  write no-ops — killing the feedback loop and preserving the cursor for the common
  (non-transforming) case.
- **IME / composition.** No send on `input` while `isComposing`; no writeback
  mid-composition.
- **Native typed values.** `bind:checked` -> `.checked`, `type=number` ->
  `valueAsNumber`, `<select multiple>` -> array. The directive yields the
  native-typed value; semantic coercion beyond that is the machine action's job.
- **Commit-timing modifier — DEFERRED (2026-06-22).** Originally `bind:value|lazy`
  (live vs commit-on-change/blur). **The `|` pipe (and `.`) do not parse as JSX** —
  TS's JSX parser rejects both (verified); only Astro/Svelte/Vue accept such
  modifiers because they ship *custom* template parsers, which we deliberately do
  not (we use the TS AST — see [[v1-compiler-against-real-templates]]). Resolution:
  **no modifier in 1.0.** `bind:value`/`bind:checked` are **live two-way only**;
  non-default commit timing (lazy/blur) or transforms (trim, etc.) use the *eject*
  path — `bind:` is "ejectable sugar," so drop it and write the explicit
  `value={x} on:change={e => m.send({ type: '@set', key, value })}` (one line, no
  new syntax, covers every non-default case). If a modifier later earns its place,
  the planned re-entry is a **preprocessor** that rewrites the desired author syntax
  `bind:value|lazy={draft.query}` → the TSX-valid `bind:value={lazy(draft.query)}`
  before the TS parse — keeping the readable pipe at authoring time without a custom
  parser. Not built; no committed need yet.

Validation is just more machine state bound back: a `valid`/`error` selector with
`bind:disabled={notReady}` and `bind:text={error}` gives live, network-free
validation — falling straight out of "reactive state is a machine."

### Committing to the server

A client script reaches a server machine by dispatching an event to it over the
existing `/__events` wire — the same protocol the POC client runtime already
speaks via `data-event-*` descriptors. The authoring surface is **not** a
string-keyed `dispatch('Name', event)` (that reintroduces the `querySelector`
smell); it is dispatch *through the imported machine def* —
`SearchMachine.dispatch({ type: 'RUN', query })` — so the import is the visible
dependency edge and the event is typed. That mechanism is specced in
[[typed-events-and-machine-mediated-dispatch]]. This is the one visible boundary
crossing in an otherwise-local client interaction, and forms are its first real
consumer. Connects to [[api-routes-and-request-response-surface]] and
[[route-request-context-with-path-params-and-query]].

### Reactivity: `bind:` first, convention/`effect` as escape hatch

- **`bind:`** is the everyday declarative path for state→DOM.
- **`{key}Changed(newVal, oldVal)`** — a convention method discovered at build
  time, auto-subscribed to the matching context key, for *imperative* reactions
  that aren't a plain node binding (driving a widget, coordinating multiple nodes,
  side effects). The DOM mutation inside is explicit and hand-authored; convention
  only decides *when* it runs. A `{key}Changed` whose key doesn't exist is a
  compile error.
- **`effect(() => …)`** — the lower-level primitive `{key}Changed` desugars to,
  for reacting to several keys at once or computed values.

This keeps one reactive system (machines) plus a "no reactivity, just imperative
code" tier (plain fields). It is explicitly *not* two competing reactive models.

### Custom elements as the client primitive

Client behavior is expressed as a custom element: the server renders the tag
(`<counter-widget>`), the `<script>` defines the class. Custom elements are the
primary primitive (not just one option) because they solve problems a flat
component-level script can't:

- **Instancing.** A component that repeats (a list of cards each with a toggle)
  can't use a flat `refs.btn` namespace. Each custom-element instance is its own
  scope; `this` is the instance; refs resolve within it. A component-level script
  is the degenerate "one instance, component is the scope" case.
- **Lifecycle / hydration for free.** `connectedCallback` is the upgrade hook — no
  framework scheduler decides when client code attaches. The machine actor is
  owned by the element, so its lifetime is the element's lifetime (which also
  means full-page navigation disposes it — client state resets by default).

### State spectrum

- **Reactive / multi-consumer / has a lifecycle → a machine.** DOM follows state
  from a single path (`bind:` or `{key}Changed`). `increment()` only sends an
  event; it never touches the DOM. This unidirectional flow (event → transition →
  DOM) is identical to the server model and is the reason to prefer it: the field
  version couples intent and DOM-write in every mutator and drifts the moment more
  than one mutator exists.
- **Trivial, single-consumer, non-reactive → a private class field.** You mutate
  it and touch the DOM by hand, inline. The rare escape hatch.

### The isomorphic engine

The planned custom state-machine engine (replacing XState,
[[custom-isomorphic-state-machine-engine]]) gets a hard requirement from this
spec: **one core that runs identically server- and client-side from the same
definition.** Server surface (Store hydration, dispatch
context, `reads` proxies) and client surface (in-browser actor, local dispatch,
no wire) are distinct capability layers over the same core.

- **Hydration is the engine's job.** Because the engine owns its serialization
  format, "server renders initial client-state, client actor adopts it on
  upgrade" is a designed-in handoff (the seed is read on `connectedCallback`),
  not a bolt-on over a foreign snapshot format.
- **Portability is defined by capabilities, not a heuristic.** "Server-pinned"
  means the machine transitively touches a server-only capability (Store, secrets,
  cross-session `emit`, or `reads:` on a server-pinned machine). "Portable" means
  it doesn't. Importing a server-pinned machine into a `<script>` is a compile
  error naming the capability. Importing a server-pinned machine into a `<script>`
  to *commit* to it is not the pattern — client code reaches the server by sending
  to a server machine over the existing wire, a visibly separate path.

### What the compiler produces

- `.stator` → `.ts` module the existing runtime consumes (per
  [[v1-compiler-against-real-templates]]).
- A client bundle per component with a `<script>` block: the custom-element class,
  its (small, portable) machine cores, the generated `bind:`/`on:`/`ref:` wiring,
  and `customElements.define`.
- A per-page **location manifest** (which machines run client-side) for
  observability — surfaced, never used to *decide* placement.
- Compile errors for: server-pinned machine on the client, unknown `bind:`/
  `{key}Changed` key, missing/renamed `ref:`, value-import of a machine in the
  template (carry-over from the compiler spec).

## Alternatives Considered

- **`lifecycle: 'client'` (or a `Stator.client()` handle) on the machine/instance.**
  Rejected. A quiet field is easy to miss (fails the "obvious from source"
  requirement) and welds location to the definition, so one machine couldn't be
  server here and client there. Import location is already a mechanism every JS
  developer reads fluently and is visible at the use site.
- **`client(() => …)` callback region in the template.** A valid-TSX expression
  form that boxes a client subtree. Rejected once we settled that no JSX runs on
  the client: there is no client-rendered markup to co-locate, so a region that
  *wraps markup* solves a problem we no longer have. The `<script>` block is the
  honest home for "code, not markup," and is the clearest single boundary marker.
- **`client { }` keyword block.** Not valid JS (parses as a bare identifier plus a
  detached block, or requires labeled-block abuse), so it maximally drags the
  template body away from standard TSX tooling. We need custom tooling regardless,
  but inventing statement keywords is the most expensive form of that.
- **Astro-style `<script>` that updates the DOM via `querySelector`/`data-*`.**
  The separation of script from the markup it controls is the intra-component
  version of the RSC spooky-action problem, and the stringly-typed selector
  connection is invisible to the compiler. We keep the `<script>` block but make
  the connection a checked `ref:`, and we keep state→DOM declarative via `bind:`
  rather than hand-wired `querySelector` + `textContent`.
- **Event-handler naming conventions (`btnClick` auto-bound to `refs.btn`'s
  click).** Rejected. A DOM event has a markup home (the element), so its handler
  belongs in markup via `on:`; a naming convention moves the wiring away from the
  element and makes "which event?" ambiguous. State *changes* have no markup home,
  which is why `{key}Changed`/`bind:` earn a non-markup declaration but events do
  not.
- **Plain reactive class fields (build-step-observed).** Rejected as the reactive
  path: observing private fields requires the build step to rewrite them into
  accessors — exactly the hidden magic we refuse. Reactivity comes only from
  machines; fields stay non-reactive.

## Open Questions

- **Live transform-on-input.** When state reformats the value as you type
  (uppercasing, phone formatting), the writeback differs from what was typed, so
  the no-op loop-break doesn't apply and the cursor jumps. Default to reformat on
  blur (`bind:value|lazy`); live reformat with selection-offset preservation is
  opt-in / later (offset mapping under transforms is genuinely hard). Two-way
  ownership and loop/IME/coercion semantics are otherwise settled — see the Form
  bindings approach above.
- **Client-to-server dispatch surface.** Resolved to machine-mediated dispatch
  (`SearchMachine.dispatch(event)`), specced in
  [[typed-events-and-machine-mediated-dispatch]]. The inline-machine `select:`
  (client-side selectors) shape is still proposed, not settled.
- **Build system.** Direction settled by the build spike (2026-06-17, see below):
  **Vite owns the `.stator` compiler (as a plugin), the client build, and dev/HMR;
  the stator server runtime owns rendering.** Vite *wraps* the TS-AST transform
  from [[v1-compiler-against-real-templates]], it does not replace it. Remaining
  sub-question: whether server-module compilation uses `vite build --ssr` or the
  compiler emits plain ESM that Node runs directly (the spike showed Vite can
  transform/load the server module, but executing `render()` still needs the
  framework's render context — so even "full SSR" is "Vite transforms, stator
  renders," which argues for the narrower client+dev scope).
- **Boundary-agnostic `bind:`.** Could a single `bind:` whose target is a server
  machine compile to a slot binding, and whose target is a client machine compile
  to a local subscription — same directive, routed by import location? This is the
  "seamless boundary" prize, but server text-position interpolation vs
  element-attribute directive is a real difference to reconcile first.
- **Client dynamic lists (deferred — viable path recorded 2026-06-21).** A list
  whose length changes purely client-side needs node *creation* in the browser,
  which has no obvious mechanism under "no client JSX renderer." Not needed for 1.0:
  most ecommerce "lists" are *server* lists (cart, search results — re-rendered via
  `each`/recompute wire patches) or fixed-shape sets the client only toggles via
  `bind:`. The viable later path for a genuine client-only dynamic list: a client
  `each(list, row => <li/>, key)` where the compiler emits the row body **once as an
  inert `<template>`** in the server HTML (real DOM the server authored — not a
  shipped renderer), and a client `each`-runtime keyed-diffs the list and
  `cloneNode`s the template per new item, rewiring each row's `bind:`/`on:`. Reuses
  the **same keyed-diff as Phase 4 keyed-`each`** (server-side) — clone replaces
  `html\`\`` as the node factory. Rejected: innerHTML-regeneration (kills focus /
  listeners / input state in rows). Build alongside Phase 4 or as a fast-follow, if
  a real client-only dynamic list appears.
- **Terser inline-machine form.** `machine({ count: 0, on: { … } })` is a proposed
  shorthand distinct from today's `defineMachine` (no `name`/`lifecycle`/`initial`/
  `states` for component-local state). This is load-bearing: if trivial machines
  aren't nearly free to declare, the field escape hatch wins for the wrong reason.
  Exact shape TBD, and how it relates to the full `defineMachine` surface.
- **Client state lifetime across navigation.** Element-owned actors reset on
  full-page navigation (usually correct for ephemeral UI). A future case may want
  persistence across navigations (web storage); per [[feedback_server_mediated_state]]
  the `bind:`/`send` call sites should stay identical regardless of where
  persistence lives. Deferred until a real case forces it.
- **Imperative third-party widgets.** The genuine imperative escape hatch (canvas,
  maps, editors) lives in the `<script>` via `ref:` + `effect()`. Confirm sufficient.

### Resolved — client reactivity & element model (2026-06-21)

- **Reactivity API → member-access + dependency inference.** `use(Machine)` returns
  a live `InstanceOf` proxy (the client mirror of the server instance proxy);
  `bind:text={qty.count}` is plain member access, and the compiler **infers** which
  `use()` actors the expression references, subscribes to all, and re-evals→diffs→
  writes on any change. One mechanism: *(dep set, value thunk)*. Supersedes the
  "one machine per element / unqualified `count`" assumption — bindings are always
  qualified by their actor (`qty.count`), so **multiple machines per element and
  multi-machine binds (`{qty.count + other.x}`) work identically** (N subscriptions,
  same body — no arity special case). `read(instance, selector)` survives as an
  optional explicit spelling, not a separate primitive. Signals rejected (second
  reactive system).
- **Client `bind:` references client actors only.** A server machine in a client
  `bind:` is a compile error (server state reaches the client via wire patches, a
  separate path). A node mixing client + server resolves by the value-vs-live-source
  distinction: a server *value* constant for the interaction is seeded into the
  client machine (below); only two genuinely-live sources on one node is the (rare,
  forbidden) smell.
- **Base class → `extends StatorElement`.** Client islands extend the framework
  base (owns actor lifecycle on connect/disconnect, `refs`, `attr()`, the binding
  loop). Name-matched to a kebab tag (`QuantityStepper` ↔ `<quantity-stepper>`),
  co-located islands, multiple per file. (See the 3b plan in
  [[stator-compiler-and-vite-plugin-implementation-plan]].)
- **Narrow hydration seed (A) in 1.0; full resume (B) deferred.** (A) server *value*
  → client machine initial context (scalar via server-rendered attribute, read on
  connect) — `use(Machine, { unitPrice: this.attr('unit-price', Number) })`. The
  engine already supports it (`createActor(def, { context })`); the seed is small
  and needed (price-×-quantity stepper). (B) serialize/resume a server-*run* client
  machine's whole state tree mid-flight stays deferred to a future release. `bind:`
  initial paint is computed at **server-render time** against the seeded context
  (selectors are isomorphic), so seeding falls out for free.

## Implementation Notes

Design converged in a POC-era design thread; this spec is the capture. Depends on
[[v1-compiler-against-real-templates]] and the custom state-machine engine.

### Spike — 2026-06-16 (`apps/private/spike/`, branch-only)

A fail-fast spike validated the runtime target by **hand-writing what the
compiler would emit** (a custom element + bind/on/ref wiring), using the existing
machine layer and XState — no SFC compiler, no custom engine built. The canonical
reactive counter plus a two-way `bind:value` draft input. Findings:

1. **Import-surface fix is required and sufficient.** A machine importing
   `defineMachine` from `@statorjs/stator/server` drags the entire server (Redis,
   `node:fs`, hono, esbuild) into a browser bundle. `define-machine.ts` is itself
   browser-safe (only `xstate` + a type-only `dispatch-context`). Added a
   `@statorjs/stator/machine` package export pointing at it; the widget then
   bundles to ~111kb with **zero** Node builtins. The isomorphic engine must keep
   the machine definition reachable without the server barrel.
2. **Isomorphism is real with today's runtime.** The unmodified machine def runs
   as a standalone in-browser-style actor via `createActor(def.xstateMachine)` —
   actions and selectors execute correctly with no dispatch context (a reads-free
   machine never dereferences the throwing `reads` proxy). Verified by a
   standalone Node actor check (INCREMENT ×2 → count 2; SET_QUERY drives the
   `hint`/`notReady` selectors). So the custom engine is a weight/ergonomics
   concern, not a correctness gate — ~111kb is XState, which is the concrete
   motivation to build the small engine.
3. **The no-client-JSX reactive model works as designed.** Client reactivity is
   `subscribe → run selector → diff lastValue → native DOM write` — the literal
   client-side analog of server `recompute`. `bind:text`, `bind:disabled`, and
   two-way `bind:value` (with loop suppression + `isComposing` guard) were all
   hand-wired against this loop.
4. **Custom-element ownership composes.** The element owns the actor across
   `connected/disconnectedCallback`; server-rendered initial DOM matches the
   machine's default context (no flicker). Attribute-seeding for non-default
   initial state is not yet exercised.
5. **Coexistence confirmed.** The framework runtime (`client.js`) and the widget
   bundle share the page without interference — the delegated listeners ignore
   nodes without `data-event-*`.
6. **Both machines together, commit path verified.** Added a server `SearchMachine`
   (`reads:` in the route, rendered via `read()` slots) alongside the client
   `CounterMachine`. The client draft commits to it via a hand-written
   `dispatch('SearchMachine', { type: 'RUN', query })` over the existing
   `/__events` wire, and the returned patches update the server-rendered slots; on
   success the client clears its own draft — one click updating both machines.
   The boundary is legible in the code: server state is provisioned in the route,
   client state imported in the widget, and the one network hop is the explicit
   `dispatch`. Verified by curl round-trip (RUN "hello" → slot patches count→1,
   summary→"hello"; second RUN accumulates in the session via the Store) — the
   dynamic payload (query from client state) rides the existing wire unchanged.
7. **Forms use case, as an automated test.** `forms-test.ts` exercises the full
   draft→commit→persist→clear flow deterministically against the real framework
   `fetch` handler (no running server, no browser): the client `CounterMachine`
   actor tracks the uncommitted `query` and validates locally via `hint`/`notReady`
   selectors; the committed draft value is POSTed to the server `SearchMachine`
   over `/__events`; returned patches are asserted (count→1, summary = the
   committed draft); the client clears its draft; a second commit proves session
   accumulation through the Store (count→2, newest-first summary). Confirms the
   value genuinely flows client-machine → server-machine across the boundary.
8. **Validation is isomorphic, and gating is defense-in-depth.** Extended the
   forms test (now 18 assertions, all green) with real form validation. A single
   pure `validateQuery` in `lib/` (not `machines/`, so discovery doesn't reject
   it) is the one source of truth, run BOTH ways: as client `errors`/`valid`/
   `error` selectors (live UX feedback — required, min/max length, format rules,
   each asserted) and as the server machine's `RUN` **guard** (authoritative).
   Two gates proven independently: the client gate blocks an invalid draft with
   **zero network calls**; a malformed event POSTed *directly* (bypassing the
   client) is rejected by the server guard — verified via the mechanism that a
   guard-blocked transition leaves context unchanged, so recompute diffs equal
   against the per-POST fresh `renderState` and returns **empty patches** (the
   origin machine is always in `touched`, but produces no patch). A final valid
   commit advances the count to exactly 3, proving neither invalid attempt
   persisted. Design takeaways for the spec: (a) validation is "just machine
   state bound back" via selectors, as claimed in Form bindings; (b) the same
   validator running client + server is the isomorphic story applied to rules,
   and argues that shared pure validators belong in a non-machine module both
   sides import; (c) client validation is UX, the server guard is the gate —
   never client-only.

Verified: browser bundling, spike typecheck, standalone actor execution, server
render of the custom element + refs, and asset serving (`GET /` and
`/static/widget.js` both 200). **Browser-verified** at `localhost:3002`
(`pnpm --filter spike-client-model start`): clicks increment, two-way input binds
and clears, scoped behavior works end-to-end. The model is confirmed in a real
browser.

### Build spike — 2026-06-17 (`apps/private/build-spike/`, branch-only)

A second fail-fast spike validated the build orchestration: can ONE `.stator`
file route through Vite to multiple outputs? A minimal Vite plugin (crude regex
split + stub codegen — the real compiler is the TS-AST transform, out of scope
here) recognizes `.stator` and emits three modules via the virtual-query pattern
Astro/Svelte/Vue use. Findings:

1. **The multi-output pattern works.** One `Counter.stator` →
   `Foo.stator` (server render module, default export), `?stator&type=client`
   (the `<script>` as a browser entry), `?stator&type=style&lang.css` (scoped
   CSS). Verified: SSR module loads with correct exports + scope-injected markup;
   `vite build` emits a browser bundle (custom element, **zero** node builtins)
   plus extracted per-component CSS; dev server transforms all three variants;
   `handleHotUpdate` invalidates all derived modules on a `.stator` change.
2. **Scoped CSS has a hard constraint (the spike's first failure).** A virtual
   style module returning raw CSS is *executed as JS in SSR* and fails to parse.
   Fix, matching real SFC plugins: give the style id a `lang.css` suffix so Vite's
   CSS pipeline claims it, and import it from the **client** entry (which bundles
   and extracts it), **not** the SSR server module (SSR doesn't execute
   stylesheets). The compiler must wire scoped styles through the client entry.
3. **Vite transforms the server module, but the framework runtime renders it.**
   `ssrLoadModule` loads the compiled `.stator` server module fine, but executing
   `render()` needs the framework's render context (`runInRender`) — that's the
   stator runtime's job, not the build layer's. So even a "full SSR build" reduces
   to "Vite transforms `.stator` → server module; the stator server process
   executes it." This is the key input to the scope decision: it argues for
   **Vite = client build + dev + `.stator` transform**, with the server runtime
   staying the framework's, rather than handing the whole server lifecycle to Vite.

Settled direction: Vite as orchestrator hosting the compiler plugin, owning the
client bundle + dev/HMR; the TS-AST `.stator` compiler stays bundler-agnostic
behind a thin plugin adapter. Open: `vite build --ssr` vs. plain-ESM emit for the
server modules.