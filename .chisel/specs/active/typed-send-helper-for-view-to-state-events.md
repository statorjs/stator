---
title: Typed send helper for the events-in handler
status: draft
created: 2026-08-07
updated: 2026-08-08
area: runtime
---

## What and Why

Thin sugar over the write path defined in
[[isomorphic-reactive-model-read-for-display-on-for-events]] — **not a primitive,
and not "the `bind:value` replacement" this spec originally claimed.** Its
first job is to remove the DOM-value ceremony from an `on:` handler; its second
— added by the model spec's controlled-input contract — is to be the
**event-side enforcement point of that contract**: the IME guard, typed value
extraction, and reconcile-after-send live here, because a hand-written
`on:input` handler is exactly where those guard rails get forgotten.

```stator
<!-- the write path is on: → a typed event; send() just tidies the handler -->
<input value={read(qty, q => q.count)}
       on:input={e => qty.send({ type: 'SET', value: e.target.value })} />

<input value={read(qty, q => q.count)} on:input={send(qty, 'SET')} />
```

The original draft was symptom-level and mis-grounded. Grounding against the code
corrected three things:

1. It reads `e.target.value`, so it is a **client-island** handler — server `on:`
   handlers run at render (no event object).
2. There is no single `form.send()`. The real targets are the **client-local
   `use().send`** (loosely typed today) and **`dispatch(Machine, event)`** (typed,
   but a server round-trip — wrong for live client-local fields).
3. So `send()` is downstream of the model spec's **foundation**: it only becomes
   fully typed once `use().send` is typed to `EventOf<D>`. Until then a `send()`
   over `dispatch` is possible but is a per-event round-trip.

## Success Criteria

- `send(inst, 'SET')` autocompletes the event name from the machine's event union
  and errors on a typo, once `use().send` is typed (the dependency).
- The DOM value is checked against the target event's payload; a string→number
  mismatch forces a visible coercion (`send(inst, 'SET_AGE', v => ({ age: Number(v) }))`),
  never silent.
- Fires a **declared** event — never `@set` or a generic setter.
- **Owns the contract's event side** (required behavior, not optional polish):
  - skips sends while `e.isComposing` (the guard that today lives in the
    compiled `@set` listener moves here);
  - **reconciles after every send** — re-syncs the bound display *regardless of
    notify*, so a guard-refused keystroke cannot leave the DOM holding text the
    machine rejected (compare `getCommitCount` before/after; mechanism below);
  - ships **typed extractors** — `fromValue` / `fromChecked` / `fromNumber`
    (`valueAsNumber`), plus a documented select-multiple recipe — so coercion
    is visible and typed, never a modifier DSL and never a silent string.
- Pure types + a tiny handler factory; no compiler change; at most one tiny
  client-runtime addition for reconcile (see Open Questions).
- Covers `.value` and `.checked`.

## Constraints

- **Must desugar to a declared event.** The line vs `@set`: a helper that reaches
  for a generic "set this key" event has rebuilt two-way binding. Non-negotiable.
- Client-island only (needs the DOM event).
- Additive; depends on typed `use().send` for full type safety.

## Approach

The event union is recoverable from a machine def via `EventOf<D>`
(`engine/types.ts:288`); passing the def infers `D` cleanly (a `use()` *instance*
is a mapped type and does not surrender `D`, so the def is the typed handle):

```ts
type Payload<D,K> = Omit<Extract<EventOf<D>, { type: K }>, 'type'>

function send<D, K extends EventOf<D>['type']>(
  target: D | ClientInstance<D>,
  type: K,
  map?: (value: string) => Payload<D, K>,
): (e: Event) => void
```

Open shape decisions in Open Questions. The mapper form is the primitive (it is
where the checked-coercion payoff lives); a `{ value }`-convention overload is the
terse case.

## Alternatives Considered

- **A `dispatch`-based `send()` as the primary.** Rejected as the default — it is
  a server round-trip, which contradicts "DOM renders where its state lives" for a
  client-local field draft. Fine as an explicit *commit-on-change* variant.
- **A generic field-setter helper.** Rejected — `@set` with extra steps.

## Open Questions

- Target: the typed `use().send` (once it exists) vs a def + `dispatch` (commit).
  Likely both, as distinct helpers/overloads with honest names.
- Mapper vs `{ value }`-convention as the documented default.
- `.value` vs `.checked` accessor selection.
- Naming — `send` collides with `instance.send`; `emit`/`dispatch` also taken.
- **Reconcile mechanism.** The helper has no handle on the compiled writer, so
  re-syncing after a refused send needs one of: a client-instance `refresh()`
  that re-notifies subscribers without a commit (smallest honest addition), or
  the compiled `value={read(…)}` wiring pairing its own writer with
  input-originated sends. Requirement is fixed by the model spec's contract;
  the mechanism is this spec's to choose.

## Implementation Notes

<!-- not built; gated on the typed-use().send foundation from the model spec -->
