---
title: Response directives for client-side effects
status: draft
created: 2026-05-21
updated: 2026-05-21
area: protocol
---

## What and Why

Today the response to a POST `/__events` is `{ patches: [...] }` and that's it. The client applies patches and the interaction is done. This works for the common case (clicks that mutate state and update the page), but it stops short of every case a real app needs.

The poll demo's "create poll and navigate to its URL" flow is the smallest example. The user submits a form. The server creates the poll and knows where the user should go next. There's no clean way to express that in the current protocol.

The why now: surfacing this as a primitive is much cheaper than letting custom solutions accrete. Without a named concept, the next person hits the same gap and reaches for a different workaround. Form pages set `location.href` from JS, SSE pages send fake patches that include URLs, modal flows leave a hidden span with the redirect target. The shape is real; it should be one of the primitives.

The deeper why: the framework already commits to "server is authoritative." That commitment should extend to "where to go next" and "what to focus" and "whether to scroll." All of those are domain decisions, not UI decisions, and they belong with the rest of the server-rendered behavior.

## Success Criteria

- A POST event response can include directives alongside patches.
- The first directive that ships is `navigate` (full-page navigation, equivalent to `location.href = path`).
- Additional directives can be added later (reload, push-url, focus, scroll, dispatch CustomEvent) without changing the response envelope or any existing directive's shape.
- The client runtime applies patches first, then directives, in array order.
- The wire format documentation describes the contract.
- Existing responses without `directives` (today's responses) continue to work unchanged.

## Constraints

- The envelope is JSON. Directives are an array of discriminated objects, same shape as patches: `{ type: 'navigate', ... }`.
- Closed semantics, open growth. Clients that see an unknown directive type log it and continue. Don't crash, don't ignore silently, don't crash other directives.
- Ordering matters. Patches are applied first so any DOM the directive references is in its new state; directives apply in array order. A `navigate` after a `focus` is harmless (the page is leaving anyway); a `navigate` before a `focus` would be wrong.
- Server is authoritative. The client never invents directives. It only applies what the server sends.
- One envelope per response. We don't stream directives over SSE in the same shape, but the SSE message format already wraps patches in `{ patches: [...] }`; if SSE ever needs to push directives, it uses the same envelope shape.

## Approach

**Envelope extension**:

```json
{
  "patches": [
    { "target": { "kind": "slot", "id": "s3" }, "op": "text", "value": "ok" }
  ],
  "directives": [
    { "type": "navigate", "to": "/p/abc-123" }
  ]
}
```

`directives` is optional. Omitted means none. Empty array means none.

**First directive**: `{ type: 'navigate', to: string }`. The client does `location.href = to`.

**Reserved directives, not yet emitted but documented**:

- `{ type: 'reload' }` — `location.reload()`.
- `{ type: 'push-url', to: string }` — `history.pushState`, no navigation. Useful for "log this URL change without reloading."
- `{ type: 'replace-url', to: string }` — `history.replaceState`, no navigation.
- `{ type: 'focus', target: { kind: 'slot' | 'element', id: string } }` — focus the addressed element. Reuses the wire-format addressing primitives.
- `{ type: 'scroll', target: { kind: 'slot' | 'element', id: string }, behavior?: 'smooth' | 'auto' }` — scroll into view.
- `{ type: 'event', name: string, detail?: unknown }` — dispatch a `CustomEvent` on `window`. Pairs with the existing `stator:*` observability hooks; lets the server tell the client to fire app-specific events.

**Client runtime change**: after `applyPatches(data.patches)`, run `applyDirectives(data.directives ?? [])`. Same simple loop, dispatching on `type`.

**Observability**: a new `stator:directive-applied` event fires per directive, mirroring `stator:patch-applied`. Same payload shape: `{ directive, timestamp }`.

**Where directives originate**: today, only the response to a POST event can carry them. A natural follow-on is letting machine actions return them (similar to how `emit:` returns events). That's deferred until a real use case forces the design.

## Alternatives Considered

- **Custom HTTP response headers** (HTMX-style: `HX-Redirect`, `HX-Refresh`, etc.). The HTMX choice is right for HTMX because their response body is HTML fragments, leaving no envelope for sideband instructions. Our protocol already has a JSON envelope. Putting directives in headers would mean a consumer reading the body but not the headers misses meaningful behavior. Headers are out-of-band; the response should be self-describing.

- **Single `redirect` field in the envelope**: `{ patches, redirect: "/path" }`. Simplest possible thing that handles the navigate case. Rejected because the next directive (reload, focus, scroll) would need its own top-level key, and we'd end up with `{ patches, redirect, focus, scroll, push-url, ... }`. Better to add the structure once.

- **Standard HTTP 303 + Location header.** Doesn't compose with patches. A 3xx response has no body, so "apply these patches AND navigate" can't be expressed.

- **Encode directives as patches** with a special op like `op: 'navigate'`. Rejected because patches are about DOM mutation, and directives are about everything else. Conflating them muddies what either means.

## Open Questions

- Whether SSE pushes ever need directives. The current SSE message is `{ patches: [...] }` for cross-session live updates. If an out-of-band server event needs to navigate every client (rare), it would push a directive. For now, defer: SSE messages don't carry directives until a real case shows up.
- Whether actions or guards can return directives. Currently they don't return anything. A future shape: an action's return value could be `{ directives: [...] }`, which the framework appends to the response. Deferred until the action's return shape is otherwise revisited.
- Server-issued directives interacting with client-issued state. Example: a client triggers a focus on input X via local handler, then a server response includes a `focus` on input Y. Server wins because it's later in the timeline. Document but don't over-engineer.

## Implementation Notes

(Not yet implemented. The poll demo's "navigate after create" is the first concrete user, and the form-submit handler in `apps/poll/templates/new-poll-page.ts` currently uses a JS `location.href` workaround that goes away once this lands.)
