---
title: Typed send helper for view to state events
status: draft
created: 2026-08-07
updated: 2026-08-07
area: runtime
---

## What and Why

The explicit view→state path today is honest but verbose:

```stator
<input value={read(form, f => f.note)}
       on:input={e => form.send({ type: 'SET_NOTE', text: e.target.value })} />
```

The ceremony is small but repetitive: pull `e.target.value`, package it into a
declared event, call `send`. A typed helper collapses it to a matched pair with
`read`:

```stator
<input value={read(form, f => f.note)} on:input={send(form, 'SET_NOTE')} />
```

`read` reads state down; `send` fires a declared event up. Two reasons this
matters now:

1. **It is the ergonomic replacement for two-way `bind:`.** The deprecation of
   two-way binding (see the companion ADR) is only palatable if the explicit
   path is nearly as terse. `send()` closes most of that gap with *zero* magic —
   it fires a real, declared, guarded event, never a generic `@set`.
2. **It is strictly more type-safe than what it replaces.** `bind:value`'s
   `@set` carries a DOM string into any context key with no compile check. A
   typed `send()` checks the event name *and* the payload against the machine.

Purely type-level — no compiler change, no runtime binding machinery. Ships in a
minor, usable alongside everything today.

## Success Criteria

- `send(form, 'SET_NOTE')` autocompletes the event name from the machine's event
  union and errors on a typo or an event the machine doesn't declare.
- The payload value type is checked against the target event. A string→number
  mismatch is a compile error that forces an explicit, visible coercion
  (`send(form, 'SET_AGE', v => ({ age: Number(v) }))`), never a silent one.
- No `@set`, no generic setter — the fired event is one the machine declares and
  guards, so the machine definition stays the complete account of state changes.
- Zero compiler or runtime additions; it is a typed library helper.
- Works for `<input>` (`.value`) and checkboxes/radios (`.checked`).

## Constraints

- **Must desugar to a declared event.** The defining line vs `@set`: if a helper
  ever reaches for a generic "set this key" event, it has rebuilt two-way binding
  and lost the completeness/guard property. Non-negotiable.
- Pure types; no directive, no compiler pass.
- Additive; no breaking change. (Removing `bind:` is a separate, breaking spec.)

## Approach

The event union is recoverable from the instance's `send`:

```ts
type EventOf<F>   = Parameters<F['send']>[0]                    // Events union
type EventName<F> = EventOf<F>['type']
type Payload<F,K> = Omit<Extract<EventOf<F>, { type: K }>, 'type'>

function send<F, K extends EventName<F>>(
  form: F,
  type: K,
  map: (value: string) => Payload<F, K>,
): (e: Event) => void
```

Two shapes for the DOM-value → payload mapping:

- **Mapper (primitive):** `send(form, 'SET_NOTE', v => ({ text: v }))` — fully
  flexible field names, `v` typed as the DOM value, return pinned to the event
  payload. This is where the checked-coercion payoff lives.
- **Convention (overload):** `send(form, 'SET_NOTE')` valid only for events
  shaped `{ type; value: string }`; autocomplete narrows to those. Terser, at
  the cost of a `value` field-name convention.

Recommend shipping the mapper as the primitive with the convention as a thin
overload. A `.checked` variant (or accessor inference) covers checkbox/radio.

## Alternatives Considered

- **Keep two-way `bind:`.** Rejected — it injects an undeclared, guard-bypassing,
  untyped `@set`. See the companion ADR.
- **A generic field-setter helper** (`setField(form, 'note')`). Rejected — it is
  `@set` with extra steps: a generic transition the machine never declared.
- **React-style callback props** (`onChange`). Rejected earlier in favor of
  keeping `on:` directive syntax; `send()` lives in the handler, not a new prop.

## Open Questions

- Mapper vs convention as the *documented* default.
- DOM accessor selection (`.value` vs `.checked`) — by the event's payload type,
  by an explicit variant, or by the element? Text vs checkbox is the split.
- Naming — `send` collides mentally with `instance.send`. `emit`/`dispatch` also
  taken. Bikeshed.

## Implementation Notes

<!-- not yet built -->
