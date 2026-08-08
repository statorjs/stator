---
title: "Isomorphic reactive model: read() for display, on: for events"
status: draft
created: 2026-08-07
updated: 2026-08-08
area: runtime
---

## Context

Grounding the two-way-binding removal against the actual code revealed the real
shape of the problem — and a cleaner target than "delete `bind:`."

**There are two state tiers, and only one is under-built.** Server machines are
reached by `read(machine, selector)` (down) and typed events (up): the server
template instance's `send` is already typed — `template/types.ts:24`,
`send(event: TEvent): EventDescriptor`. Client-local machines (`use()`) are the
weak tier: `use().send` is loosely typed — `client/use.ts:30`,
`send(event: { type: string; … } | string)` — and they are the *only* place
two-way `bind:value` / `@set` exists (`use.ts:91` `internalEvents: true`; server
actors refuse it — `http.ts:331`; `actor.ts:230` calls `@set` "a guard-bypassing
arbitrary-context write").

**`bind:` exists for a purely mechanical reason.** `read()` is server-only today:
`read.ts:49` calls `requireCurrentRenderState()`, and a `{read(...)}` updates by
the server re-computing the selector and pushing a **patch**. Client-local state
never touches the server, and the client has **no JSX re-render** (a hard
constraint from [[client-scripts-directives-and-isomorphic-machines]]). So a
`{read(...)}` text interpolation has nothing to re-run it in the browser. `bind:`
was invented to fill that hole: a directive whose generated client code
subscribes to the client actor and writes the DOM imperatively (`client-emit.ts`,
`this.track(bind(deps, thunk, writer))`). The vision spec says this outright —
`bind:` is "the client face of `read()` … declare on a node what state it shows,"
and it states the model plainly: **"Events in (`on:`) and state out (`bind:`)."**

**So two-way `bind:value` is the anomaly, not `bind:` itself.** It makes the
state-out directive also do events-in, via a guard-bypassing `@set`, on the
client tier only. And if `bind:` is genuinely "the client face of `read()`," the
honest conclusion is not to keep two `bind:` directions, nor even to keep `bind:`
— it is to make `read()` the single display primitive and let the compiler lower
it per location. `bind:`-as-display then *folds into* `read()`; it was scaffolding
for a client `read()` that didn't exist yet.

(An earlier framing of this work — the `send()` helper spec and a "deprecate
two-way / remove `bind:`" ADR — conflated the tiers and under-grounded the
mechanism. This spec supersedes that framing.)

## Decision

Adopt one reactive model across both tiers:

1. **`read(machine, selector)` is THE display primitive (out), everywhere.** The
   compiler lowers it by the machine's location (the existing import-location
   boundary): a **server** machine → render-state binding + wire patch (today's
   behavior); a **client-local** machine → the client subscribe-and-DOM-write that
   `bind:` generates today, in both text and attribute position. This is not a new
   renderer — it re-points `bind:`'s existing client codegen at a client-local
   `read()`.

2. **`on:event={… send() …}` is THE write path (in), everywhere, typed.** A DOM
   gesture produces a typed machine event. `send()` is thin sugar over this — see
   [[typed-send-helper-for-view-to-state-events]]; it is not a primitive.

3. **`@set` / two-way binding is removed — unconditionally.** The
   controlled-input loop replaces it: `value={read(qty, q => q.count)}` displays;
   `on:input={e => qty.send({ type:'SET', … })}` writes; the machine's guard runs
   (not bypassed); `read()` reflects the new value — under the contract below.

4. **`bind:`-as-display folds into `read()` and is removed — contingent on the
   client lowering.** Attribute position is bounded work; text position is the
   open feasibility question below. If text-position lowering stalls, two-way
   still dies alone in 2.0 and one-way `bind:` survives until the fold is real.
   The two halves of the removal are separable on purpose.

5. **`ref:` survives.** It is neither display nor events — an identity handle —
   so it is orthogonal and unaffected.

6. **Foundation — isomorphic parity of the client tier.** `use().send` is typed to
   `EventOf<D>` (`engine/types.ts:288`), matching the server instance and the
   stated principle "the same machine definition, server here and client there."

Net directive surface after this: **`on:` (in) + `ref:` (identity)**, with
`read()` (out) as an expression, not a directive.

## The controlled-input contract (no jank, by construction)

Why today's `bind:value` never janks: the echo is always identity. `@set` writes
the raw DOM string, the writer's `if (node.value !== s)` skips the write, the
cursor is never touched (`client-emit.ts:125`). It buys this by **making
transforms and guards impossible through the sugar**. The whole point of the
replacement is that the machine's guard and action run — so state/DOM divergence
becomes *normal*, and three failure modes appear that `bind:` structurally could
not produce:

1. **Transform jank.** A `TYPE` action uppercases/clamps → state ≠ DOM → the
   echo sets `node.value` → cursor jumps to the end. (Today's *sanctioned eject
   pattern* in the forms guide already has exactly this bug.)
2. **IME breakage.** A write to `node.value` mid-composition cancels the IME
   session. Today only the send side guards `isComposing`; the write side is
   safe by accident (identity echo). With transforms, the accident runs out.
3. **Silent desync on refusal.** A guard drops a keystroke → no commit → no
   notify → **the echo never runs** → the input keeps text the machine refused,
   until some unrelated commit. Today unreachable (`@set` always commits);
   after removal it is the *default* behavior of a guarded input.

These are framework-owned guarantees, not authoring advice — the removal works
*with* devs only if none of them can be hit from a naive template:

- **Property writes.** Client lowering of `value`/`checked` writes the DOM
  *property* (today's writer), never the attribute — the attribute form sets
  defaults only on touched controls (the `templates.md` caveat), and the
  identity-echo skip stays.
- **Selection preservation.** When the node is focused and the value diverges,
  the writer restores `selectionStart`/`selectionEnd` (clamped) around the
  write. This makes the new path *better* than today's eject pattern, not
  merely equal to `bind:`.
- **Composition safety.** The writer tracks `compositionstart`/`compositionend`,
  suppresses writes during composition, and reconciles on `compositionend`. The
  send-side `isComposing` guard moves into the input helper.
- **Reconcile-after-send.** The input helper re-runs the bound writer after
  every input-originated send *regardless of notify* (cheaply: compare
  `getCommitCount` before/after; mechanism in
  [[typed-send-helper-for-view-to-state-events]]). Contract: after every
  keystroke the DOM equals the machine's answer — committed, transformed, or
  refused.
- **Typed extractors, not modifiers.** Coercion (`fromValue` / `fromChecked` /
  `fromNumber` → `valueAsNumber`, a select-multiple recipe) lives in the helper
  — [[directive-modifiers]] correctly forbids a data-mapping DSL. This also
  fixes the forms guide's currently-false claim that `bind:value` yields native
  typed values (the emitter always reads the string).
- **Keyed rows.** Focus/cursor survival for inputs inside a keyed `each` (the
  1.0 proving-demo property) gets a regression test on the new idiom. The
  lowering must fix, not inherit, the first-match `querySelector('[data-b]')`
  resolution that today wires only row 0 when a directive sits inside a
  `.map()` in an island template.

## Consequences

**Easier:**
- One display primitive (`read()`) and one write path (`on:`), identical on both
  tiers — the isomorphic principle made real (a machine's `read()` and events work
  the same whether it is server or client-local).
- Machine-definition completeness restored — the reason two-way had to go, in
  three parts: (1) **completeness** — `@set` was a transition you never declared,
  so you could not read a machine and enumerate every way its state changes;
  (2) **guards enforced** — `@set` bypassed them (`actor.ts:230`, "guard-bypassing
  arbitrary-context write"), fenced off the server wire precisely because it is a
  hole; (3) **type-safe** — `@set` wrote a DOM string into any context key with no
  check. With writes forced through `on:` → declared events, every state change is
  greppable, guarded, and typed.
- Smaller directive surface (`on:` + `ref:`), fewer concepts to teach.
- The `bindable-prop` / `bind:`-forwarding design space never arises.

**Harder / cost:**
- `read()` needs a client-emit lowering — the main build. Bounded: the client
  subscribe-and-DOM-write already exists in `client-emit.ts`; the work is
  triggering it from a client-local `read()` (text and attribute position)
  instead of a `bind:` directive, and giving `read()` a client-safe path (no
  `requireCurrentRenderState()` in the browser).
- Breaking (removes `bind:` / two-way) → a 2.0.
- Verbosity on edits — mitigated by `send()` + [[directive-modifiers]].

**Sequencing — the 1.x prerequisite ladder (additive first, breaking last).**
Letters, not version numbers; each step ships independently and de-risks the
next (B and C could share a minor):

- **Minor A — typed `use().send` → `EventOf<D>`.** Foundation. Standalone win
  (islands currently accept event typos); the helper's types depend on it. Zero
  template changes.
- **Minor B — client lowering for `read()` + the contract writer.** Attribute
  position (incl. `value`/`checked` property writes) and text position; ships
  **alongside** `bind:`, which is internally re-implemented on the same writer
  so both paths share one code path — `bind:` users get selection preservation
  for free before 2.0. Row-0 marker fix lands here.
- **Minor C — the input helper** (`send()` + extractors) owning the IME guard,
  coercion, and reconcile-after-send. [[directive-modifiers]] rides along
  **only if** its `|`-parse hazard is resolved; otherwise it decouples — the
  helper alone carries the ergonomics.
- **Minor D — proof + deprecation.** A form-heavy example built *only* on the
  new idiom (text/number/checkbox/select, a transforming input, a guarded
  max-length input, validation, blur-commit timing, inputs inside keyed rows)
  plus a jank test matrix (cursor position, composition events, focus across
  row reorders). Docs flip to teach the new idiom first; the compiler emits a
  deprecation diagnostic for `bind:` in islands pointing at the recipe.
- **2.0 — the only breaking step.** Remove `bind:`, `@set`, `internalEvents`,
  `parseTwoWayPath` + the two-way tests; rewrite the forms guide; migration
  notes in the CHANGELOG. The runtime `bind()` fn survives (it is `read()`'s
  codegen target), and the wire's `@`-prefix 400 stays as reserved-namespace
  defense.

## Status and decision gate

**Proposed, gated — not committed.** (The superseded ADR carried "proposed, not
committed" and a decision gate; both were lost in the rewrite and are restored
here.) The 2.0 removal proceeds only after Minor D's form-heavy app proves the
helper ergonomics comfortable enough to remove `bind:` without regret **and**
the jank matrix is green on the new idiom. Until both hold, this spec is a
direction, not a decision — and per the roadmap's promotion convention, the
2.0 track is recorded there under surface hygiene.

## Open Questions

- Text-position `{read(clientMachine, …)}` in an island: does it lower to a
  managed text-slot + client write cleanly, and how does it interact with the
  server-rendered shell that hosts the island?
- `class:list` / `style:list` are compound *display* directives — do they also
  fold toward `read()`-composed attributes, or stay as sugar?
- Does anything but `ref:` remain a directive after this?
