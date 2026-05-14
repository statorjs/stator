# Wire Protocol

The contract between the stator server and any client (the bundled runtime, future SSE consumers, third-party tools). Authoritative — server emitters and client appliers must agree exactly on the shapes documented here.

## Session

Sessions are identified by an HTTP-only cookie.

| | |
|---|---|
| **Name** | `stator_sid` |
| **Value** | UUIDv4 |
| **Flags** | `httpOnly`, `sameSite=Lax`, `path=/` |
| **Lifetime** | Browser-session (no `maxAge` / `expires`) |
| **Set by** | Server, on the first GET that arrives without one |

The cookie is the only state the client carries. All session-scoped machine state is held server-side in the `Store`, keyed by the cookie's sid.

## Initial render (GET)

```
GET /<route-path>
Cookie: stator_sid=<sid>          ; optional, server sets if absent
```

Response: HTML document containing:
- Slot markers — `<span data-slot="<slot-id>">…</span>` for text positions and for `each`/`when`/`match` body containers.
- Element identifiers — `data-stator-id="<element-id>"` on any element that owns an attribute binding or an event handler.
- The client runtime bundled at `/static/client.js`.

The server discards the slot map after the response. State for patching on subsequent POSTs is reconstructed by re-rendering against current machine state inside the POST handler.

## Event POST

```
POST /__events
Content-Type: application/json
Cookie: stator_sid=<sid>          ; required
X-Stator-Route: GET <url-path>    ; required — identifies the client's current route so the server knows which machines to hydrate and which template to render for patches
```

Body:

```json
{
  "machine": "CartMachine",
  "event": { "type": "ADD_ITEM", "productId": "p1" }
}
```

Validation: `machine` must be a string referring to a discovered machine; `event.type` must be a string. Extra fields on `event` are passed through.

Success response: `200 OK` with `{ "patches": [...] }` per the patch shape below.

Error responses:

| Status | Cause |
|---|---|
| `400` | Missing `X-Stator-Route` header, or event body fails schema validation |
| `404` | Unknown route key, or unknown machine name |

## Patches

A patch is a discriminated record with two orthogonal dimensions:

- **`target`** — what part of the DOM is being updated. Two kinds:
  - `{ kind: "slot", id: "<slot-id>" }` addresses a `<… data-slot="<slot-id>">` element.
  - `{ kind: "element", id: "<element-id>" }` addresses a `<… data-stator-id="<element-id>">` element.
- **`op`** — what to do at that target. Currently `text`, `html`, `attr`. The set is closed-extensible: future ops are reserved (see below) but undefined ops should be ignored by the client with a `console.error`, never crash.

### Implemented ops

```ts
type Patch =
  | { target: { kind: "slot"; id: string };    op: "text"; value: string }
  | { target: { kind: "slot"; id: string };    op: "html"; value: string }
  | { target: { kind: "element"; id: string }; op: "attr"; name: string; value: string }
```

Semantics:

- **`text` on slot** — replace the slot element's `textContent`.
- **`html` on slot** — replace the slot element's `innerHTML`. Used for `each` list re-renders and `when`/`match` branch swaps. The new HTML may itself contain slot markers + element ids; those become the new live targets after application.
- **`attr` on element** — `setAttribute(name, value)` on the element. To unset an attribute, omit it from the value or pass empty string (current convention; see "Reserved ops" for the future explicit unset).

### Reserved ops (not yet emitted)

The wire shape must allow these without rev-bumping. Server emitters that don't produce them yet, and clients that don't apply them yet, are free to ignore — but the shape is locked.

| Op | Target | Purpose |
|---|---|---|
| `attr-remove` | element | Explicit attribute removal (currently overloaded into `attr` with empty value) |
| `attr-add` | element | Per-class / per-style toggles for finer-grained class:list updates |
| `prop` | element | IDL property writes that don't have an attribute equivalent (e.g. `input.value` once it's been user-edited) |
| `insert` | slot | Keyed list insert at a specific index, without re-rendering the parent |
| `remove` | slot | Keyed list remove |
| `move` | slot | Keyed list reorder |

The keyed list ops (`insert`/`remove`/`move`) are the path toward preserving focus, selection, and CSS transitions inside lists during reorders — an explicit V1 concern. They will require an `each` API extension (a `key:` selector) before they can be emitted.

## Patch ordering and scope subsumption

Patches in a single response form a logical batch. The client applies them sequentially in array order. Two rules govern what the server may emit:

### 1. Scope subsumption

When a list (`each`) or branch (`when`/`match`) body is replaced via an `html` op on slot `sN`, the new HTML already contains the fresh values of every binding inside that scope. The server **must not** also emit text or attr patches whose source slot is a descendant of `sN` (i.e. whose slot id starts with `sN:`).

This is a wire-correctness rule, not an optimization. If a stale descendant patch is emitted after a scope replacement:
- Today: it no-ops, because descendant slot ids don't exist in the freshly-rendered HTML.
- Future (with finer-grained patches like `insert`/`remove`): it could target an unrelated element due to id reuse, producing incorrect DOM state.

The server enforces this in `recompute.ts` via an explicit subsumption pass.

### 2. Ordering within a batch

The current server emits patches in slot-discovery order, which is parent-first per the slot allocation scheme (`each`'s slot is allocated before its body's nested reads). Combined with scope subsumption, this means an `html` patch on `sN` is always emitted before any sibling patch — and any descendants of `sN` are dropped before they would have been emitted.

Clients must not assume any specific ordering between *unrelated* patches in the batch; the only guarantee is that scope-subsumption holds.

## Slot and element id scheme

Slot ids are scoped path strings. The root scope generates `s0`, `s1`, etc. Inside an `each(items, …)` iteration, a child scope is pushed and slot ids become `<list-slot-id>:i<iteration-index>:s0`, `s1`, etc. Nested lists nest further: `s0:i0:s2:i1:s0`.

This scheme makes scope-descendant tests cheap (`startsWith(scope + ":")`) and gives every binding a stable identity for the duration of a render.

Element ids are flat sequential identifiers (`e0`, `e1`, …) allocated on demand by the parser when an element acquires an attribute binding, a directive, or an event handler. Element ids do not encode scope — descendancy of an element-targeted patch is determined via the *binding's* slot id, which the server tracks internally during recompute.

## What's not in the wire protocol (yet)

- **SSE / push channel** — V1. When added, the patch shape above is the unit of push; the framing differs (event-stream `data:` lines) but each frame's payload is `{ patches: [...] }`.
- **Multi-event POSTs** — currently one event per POST. Batching is V1+ if needed.
- **Versioning** — the shape is unversioned; additive changes (new ops, new target kinds) are forward-compatible per the "ignore unknown" client rule.
- **Per-machine event schemas** — Zod validates `{ machine: string, event: { type: string, … } }` at the wire edge today. Per-machine event payload validation is V1 work tied to typed-event plumbing.

## Implementation references

- Server emitter: `packages/stator/src/server/recompute.ts`
- Client applier: `packages/stator/src/client/runtime.ts`
- Slot id allocation: `packages/stator/src/server/render-context.ts`
- Element id allocation: `packages/stator/src/template/parser.ts`
