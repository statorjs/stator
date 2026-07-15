---
title: 'Client-side time-travel: DOM-patch scrubbing (spike first)'
status: draft
created: 2026-07-15
updated: 2026-07-15
area: tooling
---

## What and Why

A Redux-DevTools-style "scrub back through what happened" is one of the
highest-value debugging affordances a state framework can offer. The obvious
implementation — rewind the canonical machine state — is hard in Stator: state
is **server-authoritative**, spans a **graph** of machines (emits/subscribes/
`reads`), and involves **effects** (real I/O) that can't be replayed. See
[[async-data-defer-boundary]] and the audit of the engine for why server-side
rewind is a big lift.

The insight that makes this tractable: **do it client-side only, over the wire
patches.** Stator's updates aren't coarse re-renders — they're fine-grained,
targeted DOM ops (`text`/`attr`/`html`/`insert`/`remove`/`move` on specific
slots), and **every op has a clean inverse**. So the dev tool records the
inverse of each patch as it's applied and keeps an undo/redo stack; "scrub back
N events" replays the inverses in reverse. No server involvement, no state
rewind — a DOM-patch time machine. Stator is arguably *better* positioned for
this than a vDOM framework, because the patch already **is** the diff, and diffs
invert cleanly.

**This is a `spike` first.** The mechanism is clean on paper; the value of a
prototype is to surface the DOM edge cases (islands, focus/selection, keyed-list
ordering, batch granularity) before committing to a full design. We expect a few
of these to be non-obvious.

## The approach

Each wire patch maps to an inverse the applier can capture *before* it mutates:

| forward patch | inverse recorded at apply time |
|---|---|
| `text` (set `textContent`) | prior `textContent` |
| `attr` (set / remove) | prior attribute value, or its absence |
| `html` (set `innerHTML`) | prior `innerHTML` (or retained child nodes) |
| `insert` (node at index) | `remove` that node |
| `remove` (child at index) | re-insert the **retained** removed node |
| `move` | move back |

Two client-side pieces, plus a UI:

1. **Inverse capture — in the patch applier** (`wire/apply.ts`). It must be here,
   not on the existing `stator:*` observability events: those fire *after* apply,
   so they can't see the prior value. The applier is the one place with both old
   and new. In dev mode it pushes `{ forward, inverse }` onto a stack, grouped by
   patch batch.
2. **Freeze dispatch while scrubbed** (`client/runtime.ts`). A pause flag that
   swallows `on:`-handler dispatches to `/__events` while viewing the past, so
   interacting with a stale view can't advance server state and desync the
   timeline. Re-enabled on fast-forward-to-present.
3. **A scrubber in the inspector drawer** (`client/inspector.ts`) — it already
   renders the event/patch timeline off the `stator:*` contract and is the
   natural host for a slider + step-back/forward controls.

Scope-wise this is materially smaller than server rewind: applier inverse-
capture + a runtime flag + an inspector slider, all client-only, reusing the
existing observability contract and UI shell.

## What it is / isn't (state the boundary up front)

- **It is** DOM/visual history: *see* exactly what the page looked like after
  each event, and how each fine-grained update changed it. That covers most
  debugging ("what changed, when, and how did it look").
- **It is not** true state-rewind: you can't branch or replay a different action
  from a past step — the server state stays at the present, and effects aren't
  re-run. Redux's "rewind and re-dispatch" is explicitly out of scope; that would
  need the server-side machinery we're avoiding.

## Anticipated rough edges (the spike's job to shake out)

- **Client islands** *(called out as the likely troublemaker).* Islands
  (`StatorElement`) mutate their own DOM through compiled `bind:` writers
  (`compiler/client-emit.ts`), **not** the wire applier — so island-local changes
  won't be on the inverse stack. Options the spike should weigh: scope islands
  out (v1), or extend the same inverse-capture into the island DOM writers.
- **Batch vs. SSE granularity.** A patch batch can be *your* event's response or
  a cross-session live update fanned in over SSE. So the raw timeline is
  per-batch; grouping "by my event" needs the `stator:event-sent` correlation
  (available on the contract). Decide what a "step" is.
- **Ephemeral UI state.** Inverse patches restore structure/content, but focus,
  text selection, scroll position, and in-flight CSS transitions may not
  round-trip. How faithful must a scrubbed view be?
- **Keyed-list op ordering.** `insert`/`remove`/`move` are index-sequential; their
  inverses must apply in exact reverse order to reconstruct. The keyed diff
  already emits a deterministic sequence — confirm the reversal is well-defined
  under all reorder shapes.
- **Retention / memory.** Inverses for `html`/`remove` retain DOM subtrees; needs
  a ring-buffer cap and a story for large lists.
- **Non-Stator DOM.** Third-party scripts / browser autofill aren't tracked —
  standard for any DOM tool, but note it.

## Optional enhancement: state, not just DOM

Dev-mode could piggyback the touched machines' `getPersistedSnapshot()` (already
serialized for the store) onto the `/__events` response, so each timeline step
carries `event → context → DOM` — all recorded **client-side**, with no
server-rewind machinery. That gives past-*state inspection* (see the context at
step N) without unlocking state-*rewind*. A spike stretch goal, not v1 core.

## Success Criteria

**Spike (first milestone):**
- A working prototype that records patch inverses and scrubs the live DOM back
  and forward across several server-driven events, dispatch frozen while scrubbed.
- A written findings note: how islands, batch/SSE grouping, ephemeral state, and
  keyed-list ordering actually behave — and which become v1 scope vs. deferred.

**Feature (if the spike says go):**
- Step back/forward through server-patch history in the inspector with faithful
  DOM restoration for the tracked surface.
- Clear, documented boundary (DOM history, not state rewind); islands handled or
  explicitly excluded.
- Bounded memory; no interference with normal (non-scrubbing) operation.

## Notes

Emerged from a design conversation (2026-07-15) exploring Redux-style
time-travel: server-side rewind assessed and set aside; the client-side
patch-inverse approach chosen as the tractable path *because* Stator ships
fine-grained invertible patches rather than vDOM re-renders. Depends on nothing
new server-side; builds on the shipped inspector + `stator:*` observability
contract ([[inspector-and-observability-hooks]]).
