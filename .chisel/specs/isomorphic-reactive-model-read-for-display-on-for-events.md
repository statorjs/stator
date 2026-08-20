---
title: "Isomorphic reactive model: read() for display, on: for events"
status: shipped
created: 2026-08-07
updated: 2026-08-09
area: runtime
---

## Context

Grounding the two-way-binding removal against the actual code revealed the real shape of the problem — and a cleaner target than "delete `bind:`."

**There are two state tiers, and only one is under-built.** Server machines are reached by `read(machine, selector)` (down) and typed events (up): the server template instance's `send` is already typed — `template/types.ts:24`, `send(event: TEvent): EventDescriptor`. Client-local machines (`use()`) are the weak tier: `use().send` is loosely typed — `client/use.ts:30`,
`send(event: { type: string; … } | string)` — and they are the *only* place
two-way `bind:value` / `@set` exists (`use.ts:91` `internalEvents: true`; server actors refuse it — `http.ts:331`; `actor.ts:230` calls `@set` "a guard-bypassing arbitrary-context write").

**`bind:` exists for a purely mechanical reason.** `read()` is server-only today: `read.ts:49` calls `requireCurrentRenderState()`, and a `{read(...)}` updates by the server re-computing the selector and pushing a **patch**. Client-local state never touches the server, and the client has **no JSX re-render** (a hard constraint from [[client-scripts-directives-and-isomorphic-machines]]). So a `{read(...)}` text interpolation has nothing to re-run it in the browser. `bind:` was invented to fill that hole: a directive whose generated client code subscribes to the client actor and writes the DOM imperatively (`client-emit.ts`, `this.track(bind(deps, thunk, writer))`). The vision spec says this outright — `bind:` is "the client face of `read()` … declare on a node what state it shows," and it states the model plainly: **"Events in (`on:`) and state out (`bind:`)."**

**So two-way `bind:value` is the anomaly, not `bind:` itself.** It makes the state-out directive also do events-in, via a guard-bypassing `@set`, on the client tier only. And if `bind:` is genuinely "the client face of `read()`," the honest conclusion is not to keep two `bind:` directions, nor even to keep `bind:` — it is to make `read()` the single display primitive and let the compiler lower it per location. `bind:`-as-display then *folds into* `read()`; it was scaffolding for a client `read()` that didn't exist yet.

(An earlier framing of this work — the `send()` helper spec and a "deprecate two-way / remove `bind:`" ADR — conflated the tiers and under-grounded the mechanism. This spec supersedes that framing.)

## Decision

Adopt one reactive model across both tiers:

1. **`read(machine, selector)` is THE display primitive (out), everywhere.** The compiler lowers it by the machine's location (the existing import-location boundary): a **server** machine → render-state binding + wire patch (today's behavior); a **client-local** machine → the client subscribe-and-DOM-write that `bind:` generates today, in both text and attribute position. This is not a new renderer — it re-points `bind:`'s existing client codegen at a client-local `read()`.

2. **`on:event={… send() …}` is THE write path (in), everywhere, typed.** A DOM gesture produces a typed machine event. `send()` is thin sugar over this — see [[typed-send-helper-for-view-to-state-events]] (deferred, pending evidence); it is not a primitive.

3. **`@set` / two-way binding is removed — unconditionally.** The draft *pattern* replaces it, not a new primitive: the input element holds uncommitted text under platform constraints, the commit boundary sends one typed event (value read via `ref:`/`FormData`), reset/populate are safe-moment `ref:` writes. **Writing state into a focused form control is not framework surface** — see "The replacement is a pattern" below.

4. **`bind:`-as-display folds into `read()` and is removed — contingent on the client lowering.** Attribute position is bounded work; text position is the open feasibility question below. If text-position lowering stalls, two-way still dies alone in 2.0 and one-way `bind:` survives until the fold is real. The two halves of the removal are separable on purpose.

5. **`ref:` survives.** It is neither display nor events — an identity handle — so it is orthogonal and unaffected.

6. **Foundation — isomorphic parity of the client tier.** `use().send` is typed to `EventOf<D>` (`engine/types.ts:288`), matching the server instance and the stated principle "the same machine definition, server here and client there."

Net directive surface after this: **`on:` (in) + `ref:` (identity)**, with `read()` (out) as an expression, not a directive.

## The replacement is a pattern, not a primitive

The measured use cases behind `bind:` are three — display client-local state (3 sites), hold draft text until a commit (1 site), reset/populate that input (1 hand-written `@set`). Held against the minimal surface, none needs new machinery:

- **Display** → client-lowered `read()` (the fold above).
- **Draft text** → the input element holds it. Uncommitted typing is not machine-worthy state — nothing else reads it, and the docs already say "keystrokes are not events." The commit handler reads `ref:`/`FormData` and sends one typed event. Weather's `location-search` and desksmith's checkout already ship this shape.
- **Reset / populate** → a `ref:` write at a safe moment (post-commit clear, unfocused populate-for-edit).

Doctrine: **the platform guards the draft; the machine guards the commit.** Native constraints (`maxlength`, `pattern`, `inputmode`, `beforeinput`) filter input jank-free — a prevented character never appears, so there is nothing to correct — and the browser keeps IME, cursor, and the native undo stack intact because nothing ever writes into a focused control. The hypothetical cases (live validation, counters, submit-enable, search-as-you-type) are all one-way `on:` events in plus `read()` display *elsewhere* — none needs writeback. The only cases that do (live input masks, cross-element mirrors) are mask-library / hand-wired territory via `ref:`, out of scope.

`bind:` itself is the cautionary tale: a convenience primitive shipped ahead of evidence — one real two-way user, ever — that now costs a major to unwind. The replacement must not repeat it, so **no draft primitive ships preemptively**. Whether the pattern eventually hardens into a shipped reusable draft machine, an attach-style wiring, the deferred [[typed-send-helper-for-view-to-state-events]], or stays a docs recipe is decided by the proving app's paper-cut log (Minor C below) — and "a docs recipe" is an acceptable terminal answer.

### Design notes for the deferred draft question

Adjudicated while unwinding `bind:`; recorded so they are not re-derived:

- Today's `bind:value` is jank-free only because the echo is always identity (the writer's `!==` skip) — it buys that by making transforms and guards impossible through the sugar. Any controlled replacement inherits three failure modes: cursor jump on transform echo, IME cancellation on mid-composition writes, and silent desync on guard refusal (no commit → no notify → nothing ever corrects the DOM).
- Standing platform costs of any controlled path: the selection API throws on `type=number`/`email` (`selectionStart` is spec-restricted to text-ish types), and programmatic value writes destroy the native undo stack.
- Event-origin tracking ("skip writebacks my own element caused") collapses to a call-site reentrancy flag on the client tier — `send` is synchronous — and must **not** thread through the engine: UI provenance in the UI-blind layer, and on the wire it recreates the optimistic-sync echo infrastructure already rejected as a non-goal. A bare flag silently diverges under a transforming `SET`; the correct shape is defer-then-reconcile (skip the flagged notify, compare after `send` returns, write deliberately if diverged).
- Transforms in a `SET` handler split by intent: *rejection* belongs at the DOM boundary (`beforeinput`/attributes); *formatting* is view work — the machine stores the normalized value, the formatted form is a selector shown via `read()`, entering the input only at safe moments (blur/reset/populate).
- Revisit trigger for engine-level origin metadata: live cross-element mirroring with visible mid-keystroke transforms (the collaborative-editor shape) — its own adjudicated feature if ever, never a forms side effect.

## Consequences

**Easier:**
- One display primitive (`read()`) and one write path (`on:`), identical on both tiers — the isomorphic principle made real (a machine's `read()` and events work the same whether it is server or client-local).
- Machine-definition completeness restored — the reason two-way had to go, in three parts: (1) **completeness** — `@set` was a transition you never declared, so you could not read a machine and enumerate every way its state changes; (2) **guards enforced** — `@set` bypassed them (`actor.ts:230`, "guard-bypassing arbitrary-context write"), fenced off the server wire precisely because it is a hole; (3) **type-safe** — `@set` wrote a DOM string into any context key with no check. With writes forced through `on:` → declared events, every state change is greppable, guarded, and typed.
- Smaller directive surface (`on:` + `ref:`), fewer concepts to teach.
- The `bindable-prop` / `bind:`-forwarding design space never arises.

**Harder / cost:**
- `read()` needs a client-emit lowering — the main build. Bounded: the client subscribe-and-DOM-write already exists in `client-emit.ts`; the work is triggering it from a client-local `read()` (text and attribute position) instead of a `bind:` directive, and giving `read()` a client-safe path (no `requireCurrentRenderState()` in the browser).
- Breaking (removes `bind:` / two-way) → a 2.0.
- Draft inputs take a few explicit lines (`ref:` + a commit handler) instead of one directive — the cost of visible write paths. Whether that ever warrants sugar is the proving app's call, not this spec's.

**Sequencing — the 1.x prerequisite ladder (additive first, breaking last).** Letters, not version numbers; each step ships independently and de-risks the next:

- **Minor A — typed `use().send` → `EventOf<D>`.** Foundation. Standalone win (islands currently accept event typos). Zero template changes. Carries its own spike: the terse `machine(ctx, behavior)` form declares no union today (`events: {} as ClientEvent`) — deriving one from the `on` keys without re-losing the two-arg inference fight is the probe.
- **Minor B — client lowering for `read()` (display).** Text and attribute position in islands; `bind:`-as-display becomes redundant-but-working alongside it. Row-0 marker fix lands here. Whether `value`/`checked` positions lower at all is an Open Question (the focused-write doctrine says probably not).
- **Minor C — the proving STARTER + deprecation.** A form-heavy scaffoldable starter built **only** on the minimal surface (`ref:` + `on:` + `read()` + platform constraints): text/number/checkbox/select, blur commits, inputs inside keyed rows, populate-for-edit, reset. Its validation story is two-tier and is the starter's teaching spine:
  - **Shape rules run on both tiers from ONE pure function** (email format,
    length, ranges) — imported by the client machine for instant feedback and
    by the server machine's guard for enforcement. Isomorphic validation
    rebuilt on the pattern: a shared function, not a bound selector, and the
    server never trusts the client's copy.
  - **Truth rules run server-only** (uniqueness, capacity, authorization) —
    a typed dispatch whose refusal comes back as machine state the template
    `read()`s. Live variants (e.g. availability-as-you-type) use the
    debounced-event idiom weather proved.
  **Exit bar: a demonstrably jank-free form experience** — cursor, IME, focus-across-keyed-rows exercised — proven BEFORE the breaking release. Its paper-cut log is the requirements document for any draft ergonomics — a shipped reusable machine, a wiring helper, or a docs recipe, promoted only on that evidence (per the roadmap's evidence bar). Docs flip to teach the pattern; the compiler emits a `bind:` deprecation diagnostic pointing at it.
- **2.0 — the only breaking step.** Remove `bind:`, `@set`, `internalEvents`, `parseTwoWayPath` + the two-way tests; rewrite the forms guide around the pattern; migration notes in the CHANGELOG. The runtime `bind()` fn survives (it is `read()`'s codegen target), and the wire's `@`-prefix 400 stays as reserved-namespace defense.

## Status and decision gate

**DECIDED AND SHIPPED — 2.0, 2026-08-09.** The gate was evaluated against the registration starter and its paper-cut log (10 entries): the minimal pattern proved livable with zero friction on its three core moves, and the log's one real gap (refused-dispatch reasons) is a primitive question independent of drafts. Adjudication: **no draft primitive ships — the pattern + the forms guide + the registration starter are the answer.** The deprecation-cycle minor was deliberately waived (near-zero external users, Tony's call); `bind:` anywhere is a located compile error with migration guidance. Also removed with the major: the engine's `@set` + `internalEvents`, and the deprecated one-bag `machine()` form. The wire's `@`-prefix fence stays as reserved-namespace defense. The typed `send()` helper spec is archived un-built — revivable only if future evidence demands it.

## Open Questions

- `class:list` / `style:list` are compound *display* directives — do they also fold toward `read()`-composed attributes, or stay as sugar?

### Resolved (2026-08-09, Minor B built)

- **Text position lowers cleanly.** The shell renders an `<!--sN-->` comment where the expression sat; at element setup the client materializes one text node per occurrence and binds them all (`bindSlot`, `client/bind.ts`) — so a slot inside a props-driven `.map()` updates every row. Initial paint matches `bind:text` exactly (empty at SSR, painted at setup): the vision spec's "static initial context drives server paint" was never implemented, so there is nothing to regress. Attribute position reuses the element-marker `bind` machinery. Detection: `read(x, …)` routes to client codegen iff `x` is a `use()` field; embedded (non-whole-expression) client reads are a located compile error pointing at selector composition.
- **`value`/`checked`: rejected with a located CompileError** naming the covered paths — pre-fill via a server-rendered attribute, populate/reset via `ref:` at safe moments, capture via a typed commit event. Live client writes into form controls stay non-surface (decided 2026-08-09).
- **The row-0 marker defect is fixed in the same stroke**: element markers wire every occurrence (`querySelectorAll`), not just the first.
- Does anything but `ref:` remain a directive after this?
