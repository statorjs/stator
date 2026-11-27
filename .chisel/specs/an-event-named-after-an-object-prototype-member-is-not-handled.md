---
title: 'An event named after an Object.prototype member is not handled'
status: ready
created: 2026-11-27
updated: 2026-11-27
area: engine
---

## What and Why

The actor finds a handler by indexing the current state's `on` map and then the machine-level `on` map with the event type (`packages/stator/src/engine/actor.ts`, in `send`). Plain indexing reads the prototype chain, so `on['toString']` is `Object.prototype.toString`, `on['constructor']` is `Object`, and `on['__proto__']` is `Object.prototype` itself. Each is truthy, so `send({ type: 'toString' })` treats it as a declared handler: a bare function becomes `{ do: fn }`, an object becomes a config with no `when`, and the event commits (review finding 04-F13; the 2026-11 recheck's probe showed `constructor`, `toString` and `hasOwnProperty` commit on current main).

`/__events` rejects these types upstream (`server/http.ts`, `handledEvents`), so the wire is guarded. Internal paths are not: a subscription's `dispatch`, `dispatchToApp`, and a client island's `use().send`. A commit that did nothing still bumps the commit count, notifies subscribers and persists.

## Success Criteria

- `send` with type `constructor`, `toString`, `hasOwnProperty`, `__proto__` or `valueOf`, on a machine that declares none of them, returns `{ committed: false }` with no `refusal`, leaves state and context unchanged, does not bump the commit count and does not notify. That is the path every unhandled event takes since refused-dispatch reasons.
- A machine that declares a handler under one of those names, at state level or machine level, still handles it.
- `seed({}, 'constructor')` throws "which the machine does not have", as for any unknown state.

## Constraints

- Patch. No API change.
- It edits `src/engine/`, so the engine hash changes and persisted sessions reset once on upgrade. It ships in 3.1 with the other engine changes on the stack (refusal reasons, the peers rename, the node24 machine hash), so there is still one reset.

## Approach

One helper in `actor.ts`, `own(map, key)`, returns `map[key]` only when `Object.hasOwn(map, key)`. Every place the actor indexes an author-supplied map by a name that can come from outside the machine uses it:

| site | key comes from | change |
| --- | --- | --- |
| `send`: `def.states[stateKey]` | snapshot value, `seed`, `to:` | `own` |
| `send`: `node.on[event.type]` | the sent event | `own` (the finding) |
| `send`: `def.on[event.type]` | the sent event | `own` (the finding) |
| `send`: `def.emits[name]` | the transition's `emit:` | `own` (author-declared; for consistency) |
| `fireEntryEffect`: `def.states[stateKey]` | the entered state | `own` |
| `start`: `def.states[current]` on restore | snapshot value | `own` |
| `seed`: `state in def.states` | the def's `seed` result | `Object.hasOwn` |

Checked and left alone: `describe.ts` walks maps with `Object.entries`/`Object.keys`, which are own-only. `define-machine.ts` builds `emits` with `out[name] = …`, so an emit declared as `__proto__` would be lost; the name is the author's, not outside input, so it is not part of this fix. The engine does not look up `after` or selectors by name; the server does that from the state node.

## Alternatives Considered

- **Null-prototype objects in `defineMachine`** (`Object.create(null)` copies of `states` and every `on`). Fixes every reader at once, but changes the shape of `def.states` that the server, describe and tests compare against, and a def built by hand without `defineMachine` would still be exposed. The lookup is the place to fix.
- **Reject prototype names in `defineMachine`.** A machine may legitimately name an event `toString`; nothing else forbids it.

## Open Questions

- `template/conditional.ts` has the same defect in `match()` (`cases[String(v)]`, around lines 144-145): on 2026-11-27 a plain `match('constructor', { a })` and `match('toString', …)` throw "renderer must return an html`...` result", `__proto__` throws "renderer is not a function" and `valueOf` throws "Cannot convert undefined or null to object", where an unmatched key should render nothing. Outside this branch's scope (`src/template/` is being changed elsewhere); it needs its own follow-up, which is not an engine change and costs no reset.

## Implementation Notes

- `packages/stator/src/engine/actor.ts`: `own` and the sites above.
- `packages/stator/tests/engine-own-keys.test.ts`: the five names are not handled (state and machine-level handlers present, and in a state with no `on`); declared `toString` (state level) and `valueOf` (machine level) handlers fire; `seed` rejects the names; a hydrated snapshot whose state is one of them handles nothing but the machine-level handlers.
- Changeset, patch, with the reset note.
