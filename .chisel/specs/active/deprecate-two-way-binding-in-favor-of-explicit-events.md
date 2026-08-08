---
title: Deprecate two-way binding in favor of explicit events
status: draft
created: 2026-08-07
updated: 2026-08-07
area: runtime
---

## Context

Stator's identity is server-canonical, machine-authoritative state: the machine
is the single source of truth, and state changes only through explicit,
inspectable, guarded events. Two-way `bind:value` / `bind:checked` is the one
feature that breaks that law. Under the hood it injects a generic `@set` event on
every keystroke — and that produces three distinct problems, in increasing
severity:

1. **It breaks machine-definition completeness.** `@set` is a transition the
   author never declared. You cannot read a machine definition and enumerate
   every way its state can change — the transition surface is split between the
   machine (explicit `on:` handlers) and every template that binds a field. The
   co-location a state machine exists to provide is lost.

2. **It bypasses guards — confirmed in our own code.** `engine/actor.ts` calls
   `@set` "a **guard-bypassing arbitrary-context write**." It is honored only for
   client-island actors and *refused* on server actors over the wire, because a
   wire-delivered `@set` would let a client rewrite authoritative server context
   past every guard — a security hole. That fence is a confession: you only wall
   off the feature that doesn't fit the model.

3. **It is type-unsafe.** `@set` carries a DOM string into any context key with
   no compile-time check that the key accepts it (`bind:value={cart.count}` on a
   numeric `count` silently stores a string).

Secondary: two-way's local echo (the input shows keystrokes before the server
confirms) is a smuggled **optimistic update** — a stated non-goal. And the
industry already ran this experiment: React rejected Angular 1's two-way
`[(ngModel)]` for controlled `value` + `onChange`, because explicit unidirectional
flow is more predictable.

## Decision

**Proposed for a 2.0 (not yet committed):** remove two-way binding.

- Delete `bind:value` / `bind:checked` two-way behavior, the `@set` event path,
  the server-actor `@set` fence, and `parseTwoWayPath`.
- Enforce one law: **state is read via `read()`; state changes only by firing a
  declared, guarded, greppable event.** The view never mutates state directly.
- Replace the ergonomics — additively, *before* the removal — with two companion
  specs: the [typed `send()` helper](typed-send-helper-for-view-to-state-events.md)
  (view→state, event-name + payload typed) and
  [directive modifiers](directive-modifiers.md) (`on:submit|preventDefault`, the
  behavior half). Together they recover the terseness of `bind:` with none of the
  magic — every write stays a named event.

Open sub-decision: whether to keep the *one-way* `bind:text` / `bind:html` targets
(display only, no `@set`) or fold them into `read()`.

## Consequences

**Easier:**
- The machine definition becomes the complete, guarded, greppable account of
  every state change. "How can `note` change?" is answered by grepping declared
  events, not by auditing templates.
- The event log carries intent (`SET_NOTE { text }`) instead of anonymous
  keystroke noise (`@set { key, value }`) — a direct upgrade to the inspector.
- Writes become type-checked end to end (see the `send()` spec); strictly safer
  than `@set`.
- The compiler and client runtime shrink — the `@set` write path, the
  `internalEvents` gate + server fence, `parseTwoWayPath`, and the settable-path
  validation all delete.
- The entire "portable bindable prop / `bind:`-forwarding" design space never
  arises — there is nothing to make portable.

**Harder:**
- Verbosity on large forms. Mitigated by `send()` + modifiers, which close most
  of the gap; the residual cost buys visible write paths.
- Local input echo must live explicitly — a client-island `use()` field that the
  island syncs to the machine on events — rather than being magic. More code,
  but honest about where local state is.
- It is a breaking change with real migration cost.

**Sequencing (de-risks the break):** both replacements are additive and ship in
minors *first*; only the removal is breaking and lands in 2.0, *after* `send()` +
modifiers have proven the ergonomics in production. "You already have the tools,
now the old one is gone."

**Status:** proposed, not committed. The completeness argument (and the `@set`
fence as its receipt in `engine/actor.ts`) make the case strong enough to warrant
the 2.0 discussion. Suggested decision gate: a form-heavy app that proves the
`send()` + modifier ergonomics are comfortable enough to remove `bind:` without
regret.
