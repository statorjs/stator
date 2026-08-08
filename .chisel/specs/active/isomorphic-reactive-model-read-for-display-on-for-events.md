---
title: "Isomorphic reactive model: read() for display, on: for events"
status: draft
created: 2026-08-07
updated: 2026-08-07
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

3. **`bind:`-as-display folds into `read()` and is removed. `@set` / two-way
   binding is removed.** The controlled-input loop replaces it: `value={read(qty,
   q => q.count)}` displays; `on:input={e => qty.send({ type:'SET', … })}` writes;
   the machine's guard runs (not bypassed); `read()` reflects the new value.

4. **`ref:` survives.** It is neither display nor events — an identity handle —
   so it is orthogonal and unaffected.

5. **Foundation — isomorphic parity of the client tier.** `use().send` is typed to
   `EventOf<D>` (`engine/types.ts:288`), matching the server instance and the
   stated principle "the same machine definition, server here and client there."

Net directive surface after this: **`on:` (in) + `ref:` (identity)**, with
`read()` (out) as an expression, not a directive.

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

**Sequencing (additive first, breaking last):**
1. Type `use().send` → `EventOf<D>` (additive; standalone correctness win —
   client islands currently accept event typos).
2. `send()` sugar + directive modifiers (additive).
3. Client lowering for `read()` (additive — `read()` starts working client-side
   alongside `bind:`).
4. Remove `bind:` (display now covered by `read()`) and `@set` / two-way — the
   only breaking step, in 2.0, once 1–3 have baked.

## Open Questions

- Text-position `{read(clientMachine, …)}` in an island: does it lower to a
  managed text-slot + client write cleanly, and how does it interact with the
  server-rendered shell that hosts the island?
- `class:list` / `style:list` are compound *display* directives — do they also
  fold toward `read()`-composed attributes, or stay as sugar?
- Does anything but `ref:` remain a directive after this?
