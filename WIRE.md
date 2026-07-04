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
  | { target: { kind: "slot"; id: string };    op: "insert"; index: number; value: string }
  | { target: { kind: "slot"; id: string };    op: "remove"; index: number }
  | { target: { kind: "slot"; id: string };    op: "move"; from: number; to: number }
```

Semantics:

- **`text` on slot** — replace the slot element's `textContent`.
- **`html` on slot** — replace the slot element's `innerHTML`. Used for unkeyed `each` list re-renders and `when`/`match` branch swaps. The new HTML may itself contain slot markers + element ids; those become the new live targets after application.
- **`attr` on element** — `setAttribute(name, value)` on the element. To unset an attribute, omit it from the value or pass empty string (current convention; see "Reserved ops" for the future explicit unset).
- **`insert` / `remove` / `move` on slot** — keyed-list ops, emitted by `each(items, fn, { key })`. They address the slot element's **element children by index** and apply **sequentially**: each op's indices refer to the DOM state after every preceding op in the batch (the server emits them from a replay simulation, so a batch is deterministic). `insert` parses `value` and inserts it before the child at `index` (append when `index` equals the child count); `remove` deletes the child at `index`; `move` detaches the child at `from` and re-inserts it so it lands at `to`. Because addressing is by element-child index, a keyed item must render exactly one root element — the server enforces this at render.

Keyed lists exist to preserve identity: a retained row is *never* re-rendered by these ops (focus, selection, and CSS transitions survive reorders). Content inside retained rows updates through the rows' own nested slot bindings, whose slot ids are derived from the item's **key**, not its position (`s0:k<token>:s1`), so they stay addressable wherever the row moves.

### Reserved ops (not yet emitted)

The wire shape must allow these without rev-bumping. Server emitters that don't produce them yet, and clients that don't apply them yet, are free to ignore — but the shape is locked.

| Op | Target | Purpose |
|---|---|---|
| `attr-remove` | element | Explicit attribute removal (currently overloaded into `attr` with empty value) |
| `attr-add` | element | Per-class / per-style toggles for finer-grained class:list updates |
| `prop` | element | IDL property writes that don't have an attribute equivalent (e.g. `input.value` once it's been user-edited) |

## Patch ordering and scope subsumption

Patches in a single response form a logical batch. The client applies them sequentially in array order. Two rules govern what the server may emit:

### 1. Scope subsumption

When a list (`each`) or branch (`when`/`match`) body is replaced via an `html` op on slot `sN`, the new HTML already contains the fresh values of every binding inside that scope. The server **must not** also emit text or attr patches whose source slot is a descendant of `sN` (i.e. whose slot id starts with `sN:`).

The same rule applies to keyed removals: when a keyed row is dropped via a `remove` op, patches sourced from slots inside that row's key scope (`sN:k<token>:…`) must not be emitted — their targets are deleted by the remove.

This is a wire-correctness rule, not an optimization. A stale descendant patch emitted after a scope replacement either no-ops (the slot id no longer exists) or, worse, targets an unrelated element due to id reuse, producing incorrect DOM state.

The server enforces this in `recompute.ts` via an explicit subsumption pass.

### 2. Ordering within a batch

The current server emits patches in slot-discovery order, which is parent-first per the slot allocation scheme (`each`'s slot is allocated before its body's nested reads). Combined with scope subsumption, this means an `html` patch on `sN` is always emitted before any sibling patch — and any descendants of `sN` are dropped before they would have been emitted.

Clients must not assume any specific ordering between *unrelated* patches in the batch; the only guarantee is that scope-subsumption holds.

## Slot and element id scheme

Slot ids are scoped path strings. The root scope generates `s0`, `s1`, etc. Inside an unkeyed `each(items, …)` iteration, a child scope is pushed and slot ids become `<list-slot-id>:i<iteration-index>:s0`, `s1`, etc. Nested lists nest further: `s0:i0:s2:i1:s0`.

Inside a **keyed** `each(items, fn, { key })` iteration the scope is derived from the item's key instead of its position: `<list-slot-id>:k<token>:s0`, where `<token>` is the key encoded to the slot-id-safe charset `[A-Za-z0-9-]` (other characters become `_<codepoint-hex>`; the encoding is injective). Key-derived scopes are what let a patch address "the row for p1, wherever it is now" after reorders.

This scheme makes scope-descendant tests cheap (`startsWith(scope + ":")`) and gives every binding a stable identity for the duration of a render.

Element ids are flat sequential identifiers (`e0`, `e1`, …) allocated on demand by the parser when an element acquires an attribute binding, a directive, or an event handler. Element ids do not encode scope — descendancy of an element-targeted patch is determined via the *binding's* slot id, which the server tracks internally during recompute.

## The SSE push channel

Routes declared `live: true` open `GET /__sse?route=<route-key>`. The framing
is standard event-stream `data:` lines; each frame's payload is the same
envelope a POST response carries — `{ patches: [...] }` (and optionally
`directives`). Patches are diffed per connection against that connection's own
binding baseline, so successive pushes are deltas, not resets. Comment frames
(`: open`, `: keep-alive`) hold the connection through proxies; clients ignore
them per the SSE spec.

## What's not in the wire protocol (yet)

- **Multi-event POSTs** — currently one event per POST. Batching is 1.x if needed.
- **Versioning** — the shape is unversioned; additive changes (new ops, new target kinds) are forward-compatible per the "ignore unknown" client rule.
- **Per-machine event schemas** — Zod validates `{ machine: string, event: { type: string, … } }` at the wire edge today. Per-machine event payload validation is 1.x work tied to typed-event plumbing.

## Implementation references

- Wire types + client appliers: `packages/stator/src/wire/`
- Server emitter: `packages/stator/src/server/recompute.ts`
- SSE fan-out: `packages/stator/src/server/sse.ts`
- Slot id allocation: `packages/stator/src/server/render-context.ts`
- Element id allocation: `packages/stator/src/template/parser.ts`
