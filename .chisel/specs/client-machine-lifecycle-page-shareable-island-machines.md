---
title: 'Client machine lifecycle: ''page'' — shareable island machines'
status: draft
created: 2026-08-29
updated: 2026-08-29
area: architecture
---

## What and Why

Recorded 2026-08-29 from the tonysull.co admin-refactor thread. Decomposing a compose form into several islands raised the coordination question: where does shared form state live? The proposed answer — a client-side state machine — hit a framework wall: `use()` creates a FRESH actor per call (`client/use.ts` — `createActor` inside `use()`, registered with the element under construction, element lifecycle owns the actor). Two islands calling `use(SameMachine)` get two independent instances. Client machines cannot be shared.

## The framing: client machines are missing their lifecycle axis

Server machines declare `lifecycle: 'session' | 'app'` — instance sharing is defined by SCOPE, declared on the definition. Client machines have exactly one implicit scope: element. The symmetric design writes itself:

```ts
const ComposeForm = machine({
  lifecycle: 'page',   // 'element' is today's implicit default
  // …
})
```

Same vocabulary, same mental model — *an instance is shared within its lifecycle scope* — and `use()` keeps its signature: for a `page` machine it returns the page singleton (created on first `use()`), and the element's collector registers a SUBSCRIPTION to dispose instead of owning the actor.

## Implementation sketch

- A module-level `def → actor` map in `client/use.ts`; `use()` consults it when `def.lifecycle === 'page'`.
- The collectors bucket entry for a page machine owns only the binding subscription — element disconnect unsubscribes, never disposes the shared actor.
- Seeds: a `seed` argument on a page machine is first-use-wins; a conflicting later seed is a dev-mode warning (never a merge).
- Disposal: page machines live to `pagehide`. No SSR/hydration surface — client machines are client-only state.
- Additive and non-breaking: `'element'` remains the default; no existing island changes behavior.

## Evidence log (promotion gated on this)

1. **The compose form (real, 2026-08-29)**: mode/kind/upload state coordinated across three islands. Built TODAY on the userland pattern (below); becomes the primitive's migration story.
2. **Twin theme toggles (latent bug in the flagship pattern)**: the README's own island example desyncs if placed twice (header + settings page — a natural second placement). The want predates this thread.
3. **The Stage B editor island (future named consumer)**: client-tier validation shared between editor, submit affordance, and status surfaces (indie-blog paper-cut #13's declared home).

**Promotion trigger**: a second REAL consumer (the editor island), or the userland pattern hurting in the compose refactor's daily use. Pattern first, primitive second — the `bind:` lesson.

## The userland pattern (and what is NOT the hack)

The shippable pattern today: ONE brain island owns the machine; native form inputs are the input surface (no-JS baseline: radios + `:has()` CSS); the brain stamps machine state onto the form as `data-*` attributes; CSS and sibling islands read the projection; effector islands report upward via bubbling `CustomEvent`s.

Decomposition that survives the primitive: the **dataset projection stays forever** — CSS cannot read a machine under any design, so `[data-mode]` is the only CSS-bindable state surface, doubles as the no-JS baseline, and is devtools-inspectable. Only the **island↔island DOM traffic** (reading another island's projection, CustomEvent buses) is the part `lifecycle: 'page'` deletes.

## Non-goals

Cross-tab sharing (BroadcastChannel), client persistence (localStorage rehydration), and any server awareness of client machine instances — all out of scope; this is one page, one instance, by declaration.
