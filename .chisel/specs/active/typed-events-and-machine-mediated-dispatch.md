---
title: Typed events and machine-mediated dispatch
status: draft
created: 2026-06-17
updated: 2026-06-17
area: runtime
---

## What and Why

Two problems share one root and one fix, so they're specced together.

**Problem 1 — events are untyped.** Action and guard event arguments are `any`
today (`define-machine.ts:75-76,156`), a POC limitation the README already calls
out ("No type-safe `send` payloads ... part of the V1 custom machine impl"). A
machine has no declared event surface, so nothing — sender or receiver — is
checked.

**Problem 2 — dispatch uses magic strings.** Every path that delivers an event to
a machine by *name* reintroduces a stringly-typed reference the framework
otherwise works hard to eliminate. The POC client runtime POSTs
`{ machine: 'SearchMachine', event: {...} }`; the client-model spike's
`dispatch('SearchMachine', {...})` does the same. This is the client-side twin of
the `querySelector('[data-count]')` smell that `ref:` exists to kill, and of the
value-import-of-a-machine the compiler already rejects. A typo is a 404 at
runtime, not an error at build, and no static tool can answer "who dispatches to
this machine?"

**The shared fix: dispatch *through* the imported machine definition.** Instead of
naming a machine with a string, you import it and call a method on it. The import
becomes the statically-visible dependency edge, the machine name is read off the
def (never hand-typed), and — once events are typed — the payload is checked
against that machine's declared event union. One mechanism resolves both: the
import-is-the-dependency principle that already governs the client/server
boundary, applied to event delivery.

The why-now: the custom state-machine engine (replacing XState) is on the
roadmap ([[custom-isomorphic-state-machine-engine]]), and type-safe events are
the headline reason to build it. Machine-mediated
dispatch is the second consumer (after ordinary in-process `send`) that the typed
surface unlocks, and the client→server commit path in
[[client-scripts-directives-and-isomorphic-machines]] is its first real user.

## Success Criteria

- A machine declares its accepted events; actions/guards receive a typed `event`
  (a discriminated union), not `any`.
- Delivering an event to a machine requires importing that machine; there is no
  string-keyed dispatch in user code.
- `Machine.dispatch(event)` / `Machine.send(event)` reject events outside the
  machine's declared union at compile time.
- The set of machines a module can deliver events to is statically derivable from
  its imports.
- A renamed machine or renamed event propagates to all call sites through normal
  rename tooling — no string survives that a rename would miss.
- The existing `/__events` wire format (`{ machine, event }`) is unchanged on the
  wire; only the authoring surface that produces it changes.

## Constraints

- **Wire format is stable.** `{ machine: string, event: {...} }` over `/__events`
  stays as-is (see WIRE.md / the POC runtime). `Machine.dispatch` is sugar that
  produces this payload from `def.name` + the typed event; it is not a new
  protocol.
- **Name comes from the def, never the caller.** `Machine.dispatch(ev)` reads the
  target name from the imported def's `name`. User code never writes the string.
- **Same call, transport by location.** `Machine.send` (in-process, synchronous)
  and `Machine.dispatch` (over the wire) are the same conceptual delivery with
  different transports. Which one is legal is decided by where the call lives
  (server module vs. client `<script>`), consistent with the import-location
  boundary. See Open Questions on whether these are one method or two.
- **Identity import vs. value import.** Importing a server machine into client code
  to call `.dispatch` imports its *identity and event types*, not its runnable
  body. This must be distinct from a value import that runs the machine
  client-side (rejected for server-pinned machines per the client spec). Mirrors
  and extends the compiler's existing "type-only imports for machine references"
  rule.
- **Engine-dependent, not XState-bolted.** Full event-union typing is a property of
  the custom engine's `defineMachine` surface. XState v5 generics could approximate
  it but the clean version waits for the engine; this spec defines the target
  shape, the engine spec owns the mechanism.

## Approach

### Declared event surface

`defineMachine` gains a declared event type (exact syntax TBD with the engine —
likely an `events` type parameter or a schema). Actions, guards, and the
`on:` transition map are all checked against it. The event type is a discriminated
union on `type`, so `event` narrows inside each action.

### Machine-mediated dispatch

```ts
import SearchMachine from '../machines/search.ts'   // the dependency, statically visible

// client <script>: over the wire to /__events
await SearchMachine.dispatch({ type: 'RUN', query: q })   // query: string checked

// server module: in-process
SearchMachine.send({ type: 'RUN', query: q })
```

- The target name is `SearchMachine.name`; no string is written.
- The argument is typed by `SearchMachine`'s event union; `{ type: 'NOPE' }` or a
  missing/mistyped `query` is a compile error.
- The client `.dispatch` compiles to the existing `/__events` POST (the spike's
  hand-written `dispatch` helper, generalized and reusing the framework's real
  patch applier).

### Static dependency graph

Because delivery requires an import, the compiler can build a directed graph of
"module → machines it delivers to" by walking imports + `.dispatch`/`.send` call
sites — the event-delivery analog of the existing `reads:` graph. This feeds the
client/server portability check and answers "who can reach this machine?"

## Alternatives Considered

- **String-keyed `dispatch(name, event)`** (today's spike + POC wire). Rejected as
  the *authoring* surface: it's the `querySelector` smell — unchecked, un-renamable,
  not statically analyzable. Retained only as the underlying wire shape.
- **A central typed registry/enum of machine names.** Better than bare strings, but
  still a parallel structure to keep in sync and doesn't tie the dependency to an
  import. The import-the-def approach makes the dependency edge the thing that
  already exists in the module.
- **Codegen'd per-machine dispatch helpers.** A build step could emit
  `dispatchSearch(event)` functions. Rejected: more generated surface, and it
  hides the dependency that an explicit import makes obvious.
- **Type events via XState generics now.** Possible but awkward against the wrapped
  `assign`/`structuredClone` action shape, and throwaway once the engine lands.
  Deferred to the engine.

## Open Questions

- **One method or two?** `Machine.send` vs `Machine.dispatch` could be a single
  call whose transport the compiler picks from call-site location (cleaner mental
  model), or two explicit methods (transport visible at the call site). Leaning
  two, for legibility — the wire hop should be visible — but unsettled.
- **Identity-import mechanics.** How does the compiler emit "name + typed wire
  stub" for a server machine imported into client code without pulling its
  server-only body into the bundle? Likely the plugin rewrites the import to a
  generated stub. Needs the build spike to validate.
- **Response typing.** `/__events` returns patches/directives, not a machine
  result. Should `.dispatch` resolve to anything richer than success/failure
  (e.g. a typed acknowledgement)? Probably not for V1; the result is DOM patches,
  not data.
- **Engine event-surface syntax.** The exact `defineMachine` shape for declaring
  events is owned by the custom-engine spec; this spec only requires that it
  exists and is a discriminated union.
- **Cross-machine `subscribes`/`emit` typing.** The same typed-event surface should
  flow through cross-machine subscriptions
  ([[cross-machine-event-delivery-model]], [[cross-machine-effects-source-predicate-transform]]).
  In scope conceptually; sequencing TBD.

## Implementation Notes

(Not yet implemented. Captured while iterating on the client model; the
client-model spike's hand-written `dispatch('SearchMachine', ...)` is the concrete
magic-string smell this resolves. Depends on [[custom-isomorphic-state-machine-engine]]
for the typed surface; the wire format it targets already exists. Consumed by
[[client-scripts-directives-and-isomorphic-machines]].)
