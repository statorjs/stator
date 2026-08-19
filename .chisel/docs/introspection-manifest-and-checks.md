# Introspection: the manifest and `stator check`

Two unscheduled, evidence-gated developer-tooling ideas that share one substrate. Captured here so the concrete scenarios and boundaries aren't lost; the ROADMAP carries the one-line index entries that link here.

## The shared substrate

Stator's declarative surfaces are already, mostly, data the compiler computes:

- **Machines** — states, events (the union), guards, selectors, effects, timers. A full statechart, statically present in the def.
- **Components** — props (`dts.ts` → `.stator.d.ts`), client-island `static attrs` with kinds (`analyzeScriptClasses`), refs, regions, custom elements used (`LowerMeta`).
- **UI dispatch sites** — `on:click={() => m.send({ type })}` compiled from the template.

The rare thing: Stator holds **both halves** — the accepting chart *and* the UI dispatch sites — in one compile pass. XState has the chart but not the UI; React/Redux has the dispatch sites but an opaque reducer. Extract the chart to data once and two tools fall out: a **manifest** *renders* it, `stator check` *queries* it.

## The manifest

A build-time JSON description of machines + components. Not "Custom Elements Manifest for Stator" — Stator's surfaces (machines especially) are far more manifest-able than a web component, and the highest-value first output is **statechart visualization in the inspector** (a machine → rendered diagram, XState-visualizer-class; no server-canonical framework offers it). Later consumers of the same substrate: auto-generated reference docs (kills doc drift), per-state/event test scaffolding, a component gallery / "stories" (server-rendered against mock machine snapshots — *not* client prop-knobs, a real design seam), and LSP enrichment.

It is the vision serialized — "read the chart to audit" made machine-readable. Nothing has stepped outside the framework for it yet, so it stays evidence-gated. *Promotion trigger*: a user or example that hand-builds a state diagram, a component gallery, or repetitive per-state test stubs.

## Visualizing the state tree (surfaces on the manifest)

Three visualization ideas (riffed 2026-08-01). None is "the tool" — they are different *renderers* of the one manifest, forming a progression from cheap-and- broad to rich-and-deep. So the real first work is the manifest; these are surfaces.

**The Stator-unique angle: LIVE.** XState's visualizer shows a *static* chart (or a client-side interpreter). But Stator's machine state lives on the **server**, and the dev server already holds it — so any of these can attach to the running app and show the machine *transitioning in real time*, current state highlighted, event log scrolling. That is not a diagram of your machine; it is a live view of your running app's state. It's what makes this worth building — a static chart is table stakes; live server-held state in the dev loop is the differentiator.

1. **Text output — Mermaid (not PlantUML).** Cheapest, broadest reach: `stator viz MyMachine` emits a `stateDiagram-v2` block. Mermaid over PlantUML for one decisive reason — it renders *natively* in GitHub/GitLab markdown, VS Code preview, and most docs tooling, no Java/render-server. For a framework whose docs and PRs are markdown, "paste the diagram anywhere" is the killer feature (auto-generated docs diagrams, a chart in a PR, a diagram in a README). Mermaid statecharts get awkward with guards/parallel, but a flat Stator machine maps cleanly. **The seed** — proves manifest→graph, near-zero rendering infra.
2. **TUI explorer — the flagship, most on-brand.** Stator devs live in the terminal (`pnpm dev` runs there). A TUI that shows the graph *and attaches to the dev server for live state* fits the workflow — you don't leave the terminal to watch your machine work. Static mode (navigate states/transitions/guards/effects) + **live** mode (running app's machines transitioning, current state highlighted). The live mode is the compelling, genuinely novel part; effort is real (ink/ blessed) but the live half reuses the dev server's existing state access.
3. **Interactive playground / REPL — Storybook-for-machines, reframed.** Storybook's *model* doesn't transfer: a Story is "render a component with prop knobs," but a machine isn't a render — it's "instantiate, send events, inspect state." So the honest shape is a bench: pick a machine, send events (a button per accepted event), watch it transition, snapshot interesting states. Crucially it **converges with testing** — "send events, assert state" *is* the machine-test pattern, so the bench can scaffold/export test stubs. The distinctive version is "an interactive bench where exploring a machine and writing its test are the same activity," not "Storybook."

### Client vs server machines — the two-plane problem

A dev-server-attached tool only sees **server-plane** state (session/app machines). Stator also has **client-plane** machines (client islands, `machine(context, behavior)` running in the browser). A live view must account for both — but the answer is *not* necessarily a browser DevTools plugin:

- The browser **`<stator-inspector>`** is already an in-page element in the same JS context as client machines, so it can read them **directly** — no plugin needed for access. And the server can **push its machine state over the existing SSE channel**. So the browser inspector is the natural place to *unify both planes* — client machines in-page, server machines streamed — in one view.
- The **TUI** is terminal-native and **server-plane only**.
- A real **DevTools panel** is a *UX upgrade* over the in-page overlay (dockable, survives navigation), deferred — it's per-browser extension packaging for a nicer skin on access the in-page inspector already has.
- **Isomorphic machines** (same def, runs server *or* client per use-site) mean the *same* machine visualizes on different planes depending on where it is instantiated — the tool keys on the running instance's plane, not the def. The static graph (the manifest) is plane-agnostic; only the *live state* is plane-specific.

*Scope guardrail*: all of this stays well short of XState's full explorer — Tony was explicit. Read-only-ish views + a REPL bench on a manifest, not a visual authoring environment.

## `stator check`

Static checks types can't give. A spectrum from sound to heuristic; **the sound tier is the seed** — high-signal, zero false positives, and uniquely cheap because the chart is declarative.

### What the sound tier catches (worked example)

An inline-edit field. A refactor added a `saving` state and reworked `editing`; in the churn the `CANCEL` handler was dropped, but the event stayed in the union and the button still sends it.

```ts
// machines/field.ts
type Events =
  | { type: 'EDIT' } | { type: 'CHANGE'; value: string }
  | { type: 'SAVE' } | { type: 'CANCEL' }          // ← still declared
  | { type: 'SAVED' } | { type: 'FAILED' }

export default defineMachine({
  name: 'FieldMachine',
  events: {} as Events,
  context: { value: '', draft: '' },
  initial: 'viewing',
  states: {
    viewing: { on: { EDIT: { to: 'editing', do: seedDraft } } },
    editing: {
      on: {
        CHANGE: { do: setDraft },
        SAVE:   { to: 'saving', effect: saveField },
        // CANCEL: { to: 'viewing' }  ← removed in the refactor, never re-added
      },
    },
    saving: { on: { SAVED: { to: 'viewing', do: commit }, FAILED: { to: 'editing' } } },
  },
})
```

```jsx
// components/field.stator
<button on:click={() => field.send({ type: 'SAVE' })}>Save</button>
<button on:click={() => field.send({ type: 'CANCEL' })}>Cancel</button>
```

- **`tsc`** passes — `CANCEL` is a valid union member; types encode *what events exist*, never *which are handled*.
- **A test** likely passes too — a dead button throws no error; you catch it only if you happened to assert the exact path that broke.
- **`stator check`** fails:

```
stator check: dead event  (1 problem)

  FieldMachine · event 'CANCEL' is dispatched by the UI but handled in no state
    declared    machines/field.ts:5         (events union)
    dispatched  components/field.stator:2   field.send({ type: 'CANCEL' })
    handlers    none

  A user clicking this control gets a silent no-op — and here, no way out of
  `editing` except Save. Add a handler (e.g. editing: { on: { CANCEL: { to:
  'viewing' } } }) or remove the control.
```

The value: a real UX dead-end (can't cancel an edit), invisible to types and to typical tests, the classic refactor-drift shape — caught soundly because "declared + dispatched by UI + handled in zero states" has essentially one cause: dead code. Sibling check on the same substrate: **unreachable state** (a state no `to:` points at, not `initial`).

The sound tier must count *all* handler sites (state `on:`, and machine-level `on:` if added) and *all* event sources (effect returns, `after:`, `dispatch:`, subscriptions), so "dead" means genuinely handled-nowhere, not merely UI-unsent — otherwise an effect-only event false-positives.

### What it deliberately does NOT catch (the boundary — worked example)

A false negative: a genuinely broken checkout the sound tier waves through.

```ts
// machines/checkout.ts
type Events = { type: 'ADD_ITEM'; id: string } | { type: 'VERIFY_PAYMENT' } | { type: 'PLACE_ORDER' }

export default defineMachine({
  name: 'CheckoutMachine',
  events: {} as Events,
  context: { items: [] as string[], payment: 'unverified' as 'unverified' | 'verifying' | 'verified' },
  initial: 'shopping',
  states: {
    shopping: {
      on: {
        ADD_ITEM:       { do: addItem },
        VERIFY_PAYMENT: { to: 'checkout', effect: startVerify },  // ← never sets payment
      },
    },
    checkout: {
      on: {
        PLACE_ORDER: {
          when: (ctx) => ctx.payment === 'verified',   // guard: never satisfiable
          to: 'placed',
          effect: submitOrder,
        },
      },
    },
    placed: {},
  },
})
```

Nothing ever assigns `ctx.payment = 'verified'` (the completion that used to set it was dropped), so `PLACE_ORDER`'s guard can never be true → **the store cannot take orders.** Yet:

```
stator check: no problems found ✅
```

The sound tier asks *"is `PLACE_ORDER` handled in a reachable state?"* — yes: `checkout` handles it and is reachable via `VERIFY_PAYMENT`. Structural handler present, state reachable → passes. The button is dead and CI is green.

Why it's out of reach: the flaw is in *data flow*, not chart *structure*. Proving the button is dead means proving `ctx.payment` can never become `'verified'` — abstract interpretation of arbitrary TypeScript across every action that mutates `payment`, undecidable in general (the value could come from an effect payload or external data). The sound tier reasons about *structural presence*, not *satisfiability*, precisely so it stays sound (zero false positives). Reaching into guard logic is where false positives and undecidability begin.

A second false-negative class, same root: **context-dependent no-ops.** If `PLACE_ORDER` were also handled in `shopping`, a "Place order" button rendered during `shopping` would work while the same event no-ops elsewhere — the sound tier sees "handled in *a* reachable state" and passes; correlating *which* state a control renders under is the heuristic tier's job. Both false negatives share a root: the sound tier reasons about the chart's *shape*, never about *values or render context*.

### The documentation boundary

State it plainly so the tool doesn't over-promise:

> `stator check` catches dead **code** — an event no state handles, a state
> nothing reaches. It does **not** catch dead **logic** — a handler whose guard is
> never satisfiable, or context that never reaches the value a transition needs.
> "No problems found" means "no structurally dead events," not "every control
> works."

That boundary *is* the credibility: a **sound** check (never cries wolf) earns a place in CI; the moment it guesses at guard logic it turns noisy and gets ignored. Catch the whole structural-dead-code class reliably; leave dead logic explicitly out of scope (heuristic tier, opt-in, later).

*Promotion trigger*: the manifest substrate landing (the hard part — chart-as-data — is then already paid for), or an example whose UI ships a dead event a check would have caught.
