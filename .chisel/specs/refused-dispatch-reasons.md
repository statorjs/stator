---
title: Refused-dispatch reasons
status: draft
created: 2026-11-22
updated: 2026-11-22
area: engine
---

## What and Why

An event a guard refuses answers `committed: false` and nothing else. The guard knew why (shape-invalid, duplicate email, sold out); the caller cannot find out. Three independent motivations are on record:

1. `.chisel/docs/registration-paper-cuts.md` entry 1 (2026-08-09): the desk refuses `REGISTER` for three distinguishable reasons and the form can only say "the event may be sold out, or this email is already on the roster". It asked for "a typed refusal channel on dispatch (`{ committed: false, reason }` from a guard-declared vocabulary)". The 2.0 gate adjudicated it "the log's one real gap" ([[isomorphic-reactive-model-read-for-display-on-for-events]], "Status and decision gate").
2. [[agent-tools-from-the-state-graph-the-webmcp-skin]] (2026-10-28): the tool result is `{ committed, reason?, reads }`, and "the refused-dispatch-reasons thread gains its consumer here".
3. `.chisel/docs/indie-blog-paper-cuts.md` entry 13 (2026-08-28): the no-navigation form (post as a typed event, guard refuses, error patches in, fields never reset) "is blocked on the parked refused-dispatch reasons work".

**What is actually missing.** Errors as machine state are expressible today: a candidate array whose last, unguarded candidate writes `ctx.error`. The registration starter built that and rejected it, for two reasons that are both in the log. It makes `committed` meaningless to the caller (entry 1: "the always-commit + lastResult contortion"), and it stores an event-shaped fact as session state, so the message survives a refresh with an empty form (entry 8, adjudicated: "an acknowledgement is event-shaped and page-local", it moved to the island's client machine). So the gap is not a place to keep an error. It is three narrower things:

- a guard returns `boolean`, so a refusal carries no data (`engine/types.ts:49`);
- `Actor.send` returns `void`, and the host learns "committed" only by comparing commit counts (`server/session-runtime.ts:273`);
- the wire envelope and every dispatch result carry `committed` and no more (`wire/index.ts:59`, `client/dispatch.ts`, `server/api-route.ts:72`, `server/app-dispatch.ts`).

Displaying the reason needs nothing new. The registration form already shows its refusal line and its four field errors through client-machine `read()` slots (log entry 10: "the pattern held with no paper cut"). The reason only has to reach the island.

**Doctrine.** "Read the machine, know every way its state changes" is untouched: a refusal changes no state. The reason is the answer to one dispatch, held by nobody after the response is written. The rule this spec adds to the entry-6/entry-8 taxonomy: *a reason that guards or domain logic later act on is state, and gets a transition (a declined payment is a `declined` state); a reason only the sender needs is a result, and rides the dispatch.*

This spec also fixes the envelope that [[event-payload-schemas]] (3.2) fills: a schema failure is a refusal with per-field issues, on the same channel.

## Success Criteria

- A guard can refuse with a code, an optional message and optional per-field issues. `dispatch()` in an island, `dispatch` in an API route and `dispatchToApp` all return it beside `committed: false`.
- The registration starter tells "duplicate email" from "sold out" and puts the duplicate message under the email field, with no new template syntax and no context added to `DeskMachine`.
- A machine that never calls `refuse` behaves and types exactly as in 3.0.3. Every existing test passes unchanged.
- `/__events` responses that carried no refusal are byte-identical to today's, status included.
- A response that carries a refusal is a 422, and a retried refused event replays the same body and the same status.
- The body of a non-2xx `/__events` response reaches app code: a refusal as `result.refusal`, the server's `error` string as `result.error.message`.
- A refusal is only ever present with `committed: false`.
- The refusal shape holds a Standard Schema issue list (path + message) without change, proved by a test that maps one in.
- Nothing about a refusal is sent to anyone but the caller that dispatched, and only after every admission check `/__events` runs today has passed.

## Constraints

- Minor (3.1), non-breaking. `Guard` keeps returning `boolean`. No existing signature narrows.
- No new binding kind, no new template directive, no slot or element-id work. Errors display through `read()` on a client machine, which exists.
- The engine stays isomorphic and I/O-free. The refusal is collected inside `send`, not through a host hook.
- The engine stores nothing. No snapshot field, no machine-hash input beyond the engine's own code changing (the engine hash moves once, as for any engine change; the changeset says so).
- Admission failures keep their statuses and bodies (`server/http.ts:648-770`). A refusal is not a new way to learn which machines or events exist.
- The status moves only for a response that carries a refusal. A machine that never calls `refuse` (and in 3.2 declares no schema) is answered exactly as in 3.0.3, so a hand-written client or a test that checks `res.ok` on `/__events` changes only when the app opts in.

## Approach

### The shape

```ts
// engine/types.ts
export interface RefusalIssue {
  /** Where in the event payload: ['email'], ['guests', 2, 'name']. Empty = the whole event. */
  path: ReadonlyArray<string | number>
  message: string
}

export interface Refusal<Code extends string = string> {
  /** The machine's own vocabulary: 'duplicate', 'full'. Stable; what code branches on. */
  code: Code
  /** A sentence for a person. Optional: a client may own the wording and key it by code. */
  message?: string
  /** Per-field problems. What a schema failure fills in 3.2. */
  issues?: RefusalIssue[]
}
```

`code` is required because every consumer branches on something (the island, an agent, a webhook receiver) and a message is the wrong thing to branch on. `issues` is the Standard Schema issue with its path flattened to `string | number`, so 3.2 maps a validation failure in with no second shape. `'invalid'` is the conventional code for "the payload is wrong, see `issues`"; a 3.1 guard that hand-checks fields uses it, and 3.2's schema failure produces the same code, so client code written against 3.1 does not change.

No free-form `data` field in 3.1. Nothing in the three logs needs one, and what a refusal would carry (seats left) is already readable state.

### Where a reason originates: `helpers.refuse`

```ts
// engine/types.ts
export interface GuardHelpers<R = Record<string, any>, Code extends string = string>
  extends ActionHelpers<R> {
  /** Record why this guard is refusing, and refuse. Always returns false. */
  refuse(code: Code, detail?: { message?: string; issues?: RefusalIssue[] }): false
}

export type Guard<C, E extends EventObject, R = Record<string, any>, Code extends string = string> = (
  ctx: C,
  ev: E,
  helpers: GuardHelpers<R, Code>,
) => boolean
```

```ts
REGISTER: {
  when: (_ctx, ev, { reads, refuse }) => {
    const clean = cleanRegistration(ev)
    if (!clean) return refuse('invalid', { issues: registrationIssues(ev) })
    const roster = reads.RosterMachine
    if (roster.attendees.some((a) => a.email === clean.email))
      return refuse('duplicate', {
        issues: [{ path: ['email'], message: 'That email is already on the roster.' }],
      })
    if (roster.seatsTaken + clean.seats > roster.capacity)
      return refuse('full', { message: 'Not enough seats are left for a party that size.' })
    return true
  },
  emit: 'REGISTERED',
},
```

Why a helper that returns `false` and not a widened return type: a refusal object is truthy. `when: (c, e) => notDuplicate(c, e) && hasRoom(c, e)` is how guards compose today, and with `boolean | Refusal` the expression `refusal && true` evaluates to `true` and the event commits. `refuse(...)` is `false`, so every existing way of combining guards stays correct, and the guard's return type does not change. A guard function annotated with `ActionHelpers` still assigns (a function that accepts the supertype accepts the subtype).

Rules, all in `actor.send` (`engine/actor.ts:233`):

- `send` builds one `refuse` per call. The first refusal recorded during that `send` is kept; later calls still return `false` and record nothing.
- If a candidate's guard passes (`actor.ts:259` loop), the event commits and any recorded refusal is dropped. With a candidate array, a reason reaches the caller only when every candidate refused.
- An event the current state does not handle (`actor.ts:251`) is refused with no refusal. The framework invents no codes in 3.1.
- `refuse` exists only on the helpers handed to guards. Actions get `ActionHelpers` as before; an action has already committed.

### The engine result

```ts
// engine/actor.ts
export interface SendResult {
  /** A transition matched and fired. */
  committed: boolean
  /** Present only when committed is false and a guard said why. */
  refusal?: Refusal
}

interface Actor<C, E> {
  send(event: E): SendResult   // was void
  …
}
```

`void` to a value is compatible for every caller. `getCommitCount` stays (subscription wiring and the hosts use it).

### Hosts

- `server/session-runtime.ts`: `dispatchEvent(machineName, event): { touched: Set<string>; refusal?: Refusal }` does what `processEvent` does and returns the origin actor's refusal. `processEvent` stays, as `dispatchEvent(...).touched` (it is on the `/server/runtime` toolchain tier, and compiled output and tests call it).
- Only the **origin** machine's refusal is returned. A subscriber that refuses a delivered emit (`session-runtime.ts:226`) is not the caller's business: the origin committed, and the subscriber is often an app machine holding other sessions' state. It is logged at `debug` (machine, event type, code; never the message or issues).
- `/__events` (`server/http.ts:803-836`): the envelope gains `refusal` when the origin refused, and that response is a **422**. A bare `committed: false` stays 200. The replay cache records the status beside the body (see "The wire"), so a retried refused event replays its refusal as a 422.
- The request logger writes 4xx at `warn` (`server/http.ts:311`). A 422 from `/__events` is a visitor's typo, not a fault, so it logs at `debug` like a 200. Other 4xx stay at `warn`.
- API-route `dispatch` (`server/api-route.ts:63`, type in `server/routing.ts:145`) returns `{ committed, refusal? }`. The handler decides what the reason becomes: a field in its JSON response, a 422, a stash for the bounce (the indie-blog multipart recovery).
- `dispatchToApp` (`server/app-dispatch.ts`, and the bound method on the app in `server/create-app.ts:181`) returns `{ committed, refusal? }`. A webhook route can answer "duplicate" by code instead of inferring it from `committed`.
- Events with no caller: effect completions (`server/effects.ts:103`, `:268`), `after` sends (`server/timers.ts:83`), emit deliveries. A refusal there is logged at `debug` and goes nowhere else. There is no client to tell and no store to put it in.
- Template `machine.send(...)` outside a render (`server/instance-proxy.ts:66`) keeps returning `undefined`.

### The wire

```ts
// wire/index.ts
export interface WireEnvelope {
  patches?: Patch[]
  directives?: Directive[]
  committed?: boolean
  /** POST /__events only, and only with committed: false: why the target machine refused. */
  refusal?: Refusal
}
```

A refusal is a **422** carrying the same envelope a 200 carries:

```
HTTP/1.1 422 Unprocessable Content
Content-Type: application/json

{
  "patches": [],
  "directives": [],
  "committed": false,
  "refusal": {
    "code": "duplicate",
    "issues": [{ "path": ["email"], "message": "That email is already on the roster." }]
  }
}
```

`patches` is always empty on a 422: nothing committed, so nothing was touched (`http.ts:805`, recompute runs over `touched`). The field stays so that one parser reads both statuses. `refusal` is additive under WIRE.md's "ignore unknown" rule and is never sent on SSE frames.

**Status per case.** Two body shapes exist and the status says which: an **envelope** (the machine was asked) or `{ error: string }` (the request was turned away before any machine saw it). Only the two 422 rows are new; every other row is what `server/http.ts` answers today.

| Case | Status | Body | Since |
|---|---|---|---|
| Committed | 200 | envelope, `committed: true` | today |
| Bare refusal: the current state does not handle the event, or a guard returned `false` without `refuse()` | 200 | envelope, `committed: false`, no `refusal` | today |
| The page's middleware would redirect this caller (`http.ts:677`) | 200 | envelope, `committed: false`, a `navigate` directive | today |
| A guard called `refuse()` and no candidate passed | **422** | envelope, `committed: false`, `refusal` | 3.1 |
| Schema validation failed | **422** | envelope, `committed: false`, `refusal: { code: 'invalid', issues }` | 3.2 |
| Malformed envelope: no `X-Stator-Route`, malformed route key, body is not JSON, `machine` or `event.type` missing, an `@`-reserved type, a type no part of the chart handles | 400 | `{ error }` (plus `detail` for a parse failure) | today |
| Unknown route, a data route's key, unknown machine | 404 | `{ error }` | today |
| An app machine addressed from the browser | 403 | `{ error }` | 3.0.3 |
| A `serverOnly` event | 403 | `{ error }` | today |
| The page does not offer the event (gate `enforce`) | 403 | `{ error }` | 3.0 |
| The page's middleware refuses this caller | the middleware's status when it is 4xx or 5xx, else 403 | `{ error: 'not admitted to this route' }` | today |
| Body over `events.maxBytes` | 413 | `{ error }` | 3.0 |
| Cross-site write (`server/csrf.ts:71`, before routing) | 403 | `{ error: 'cross-site request blocked' }` | today |
| A guard, action or render threw | 500 | not JSON (Hono's default text body; there is no `onError`) | today |

Why a bare `committed: false` stays 200: it is "not now", not "you got it wrong". A stale click on a button whose state moved on is the common case, it is benign, and it should not paint a red line in the console. A guard that calls `refuse()` is saying the sender needs to know, and that is the 422. The rule a reader can hold: *a 422 always has a `refusal`; a 200 never does.*

A client tells a refusal from any other 422 by the body, not the status: it is a refusal when the JSON has a `refusal` object with a string `code`. An app's own middleware can answer 422 for admission, and a proxy can replace a 4xx body with its own page (`proxy_intercept_errors` in nginx, platform error pages); both arrive with no `refusal` and are reported as an HTTP failure. The deployment guide says to leave `/__events` bodies alone.

**The replay cache** (`server/event-dedupe.ts`) stores a body string and `http.ts:783` replays it with a hardcoded 200. It stores the status too:

```ts
export function record(sessionId: string, eventId: string, body: string, status = 200): void
export function replayFor(sessionId: string, eventId: string): { body: string; status: number } | undefined
```

`/__events` records `(JSON.stringify(envelope), 422)` for a refusal and replays `c.body(cached.body, cached.status, …)`. A retry only happens when the first response was lost (the client retries network failures and timeouts, never a status), and without the status a lost 422 would come back as a 200 with a `refusal` in it. Replaying is also the right answer on its merits: the guard is not asked again, so a seat that freed up between the attempt and the retry does not turn one click into a different outcome than the one the server already logged.

Responses that never reach the session lock are not recorded and do not need to be: every admission check, and the 3.2 schema check that runs before the lock, is a pure function of the request, so a retry computes the same answer.

**What a refusal may say.** It is written by the app's guard and read by whoever sent the event, so it is as public as the page. The docs state it the way the event-gate docs state "it is not authorization": do not put another session's data in a message ("already registered by tony@…"). The framework's part is ordering: a request gets a refusal only after route admission, machine lookup, the session-lifecycle check, `serverOnly`, the handled-event check and the offered-event gate have all passed (`http.ts:660-770`), and those keep answering as they do today.

WIRE.md changes: the Event POST section gains `refusal`, the 422, and the status table above (its current error table lists only 400 and 404, and has been stale since the 403 and 413 cases shipped); the SSE section's "a guard-dropped event is HTTP 200 with `committed: false`" gains "unless the guard gave a reason, which is a 422"; the replay paragraph says the status is replayed with the body.

### The client

The transport reads the body of every response. Today `postEvent` (`client/transport.ts:93-95`) logs `await res.text()` to the console for a non-2xx and returns `{ phase: 'http', status }`, so the server's 400, 403, 404 and 413 sentences never reach app code, and a 422 would lose its refusal.

```ts
// client/transport.ts
export interface DispatchError {
  phase: 'network' | 'timeout' | 'http'
  /** HTTP status. Present only for phase 'http'. */
  status?: number
  /** The server's `error` string, when the response body was JSON and had one. */
  message?: string
}

export type PostEventResult =
  | { ok: true; status: 200 | 422; envelope: WireEnvelope }
  | { ok: false; error: DispatchError }
```

`postEvent` parses the body itself and returns the envelope, where it used to return the `Response` for each caller to parse. Its rules, in order:

1. The request never completed: retry as today (300 ms, then 1 s, same `eventId`), then `{ ok: false, error: { phase: 'network' | 'timeout' } }`.
2. Read the body as text and try `JSON.parse`. The body can be read once, so this happens before any branch.
3. A 2xx with a JSON object: `{ ok: true, status: 200, envelope }`.
4. A 422 whose JSON has a `refusal` object with a string `code`: `{ ok: true, status: 422, envelope }`. No `console.error`, no `stator:dispatch-error`. The browser prints its own red network line for the 422; that is accepted.
5. Anything else non-2xx: `{ ok: false, error: { phase: 'http', status, message } }`, where `message` is the body's `error` when it is a string and is absent otherwise (a 500's text body, a proxy's HTML page). `console.error` prints the status and the message.
6. A 2xx whose body is not a JSON object: `{ ok: false, error: { phase: 'http', status, message: 'malformed response body' } }`.

No status is retried, a 422 included: the server saw the event and answered. A failure from rules 1, 5 and 6 fires `stator:dispatch-error` once, as today, with `message` added to its detail.

Rule 6 is a behavior fix. Today the page runtime logs "malformed response" and fires nothing (`runtime.ts:402`), and island `dispatch()` calls `res.json()` with no guard (`dispatch.ts:43`), so a 200 with a bad body rejects a promise the docs say never rejects.

```ts
// client/dispatch.ts
export interface DispatchResult<Code extends string = string> {
  /** The server processed the event and answered with an envelope: a 200, or a 422 that carries a refusal. */
  ok: boolean
  /** The event committed a transition. */
  committed: boolean
  /** Patches applied to this page. */
  patchCount: number
  /** Why the machine refused. Only with ok: true and committed: false, and only when a guard said. */
  refusal?: Refusal<Code>
  /** Present only when ok is false. */
  error?: DispatchError
}
```

`ok` no longer means "returned 200". It means the machine was asked and answered; `ok: false` means the event never got that far or the answer did not arrive. Every case:

| What happened | `ok` | `committed` | `refusal` | `error` | Window event |
|---|---|---|---|---|---|
| 200, committed | `true` | `true` | | | |
| 200, bare `committed: false` | `true` | `false` | | | `stator:dispatch-refused`, no `refusal` |
| 422 with a refusal | `true` | `false` | `{ code, message?, issues? }` | | `stator:dispatch-refused` |
| 400, 403, 404, 413, or a middleware status, with a JSON `error` | `false` | `false` | | `{ phase: 'http', status, message }` | `stator:dispatch-error` |
| 422 with no `refusal` in the body | `false` | `false` | | `{ phase: 'http', status: 422, message? }` | `stator:dispatch-error` |
| 5xx, or any non-2xx with a non-JSON body | `false` | `false` | | `{ phase: 'http', status }` | `stator:dispatch-error` |
| 2xx with a body that is not a JSON object | `false` | `false` | | `{ phase: 'http', status, message: 'malformed response body' }` | `stator:dispatch-error` |
| Network failure after two retries | `false` | `false` | | `{ phase: 'network' }` | `stator:dispatch-error` |
| Timeout after two retries | `false` | `false` | | `{ phase: 'timeout' }` | `stator:dispatch-error` |

`refusal` and `error` are never both present. An island's branch order does not change: `if (!result.ok) … else if (result.committed) … else …` reads the same before and after, and the last branch now has `result.refusal`. `dispatch()` applies `envelope.patches` and `envelope.directives` for a 422 as for a 200 (both are empty today; one code path). `Refusal` and `RefusalIssue` are exported from `@statorjs/stator/client` and `@statorjs/stator/machine`.

**Template sends.** The page runtime's sends (`client/runtime.ts:335`) have no caller to return to. The runtime takes the same `PostEventResult`, applies the envelope for a 200 or a 422, and fires one window event, `stator:dispatch-refused`, with `{ machine, event, refusal?, timestamp }` when the envelope says `committed: false`. `refusal` is absent for a bare refusal. Island `dispatch()` fires the same event; the emit lives in `client/transport.ts` beside `emitDispatchError` so both callers share it. It sits beside `stator:dispatch-error` and serves the same two readers: one page-level listener (a toast), and the dev inspector. A refusal never fires `stator:dispatch-error`: that event stays for transport and protocol failures, so a listener written against 3.0 that shows "something went wrong" does not start firing for a mistyped email. `data-stator-pending` clears on every path, as today.

This is the whole of the server-template story in this spec, on purpose: a template event carries nothing from the browser (`wire/template-events.ts`), so a form with fields is always an island, and an island has the result in hand. What a server-template page can do with these two events, and whether a scope narrower than the page should exist, is [[client-side-event-error-handling]].

**The inspector** (`client/inspector.ts:479`) lists `stator:dispatch-error` as a `✕` row with the phase and the status. It adds the `message` to that row, and a row for `stator:dispatch-refused` showing the code. Nothing in it treats a non-2xx as fatal: its patch log is driven by `stator:patches-received`, which a 422 fires with an empty list like any committed-nothing response.

**Enhanced form submits** (`runtime.ts:364`, `data-stator-enhance`) post to an API route, not to `/__events`, and drop a non-2xx body the same way. They get the same reading: a JSON `error` string reaches the `stator:dispatch-error` detail as `message`. Whether a 4xx from an API route should have an envelope applied (its directives, say) is an open question below; an API route that answers 422, which this spec invites under "Hosts", is otherwise still a dead end for an enhanced form.

**A page from before the deploy.** Islands and `/static/client.js` are built with the app, so client and server normally agree. A tab opened before a deploy that added `refuse()` runs the old transport against the new server, and reads the 422 as `{ ok: false, error: { phase: 'http', status: 422 } }`: the form says it could not send when in fact it was refused. Nothing is committed either way, live routes reload on their next reconnect (the build-id handshake, `http.ts:565`), and a non-live page corrects on its next navigation. Shipping the transport PR a release ahead of the first `refuse()` narrows the window further. Accepted.

### The form, before and after

Before (`examples/registration/templates/reg-form.stator`, today):

```ts
const result = await dispatch(DeskMachine, { type: 'REGISTER', ...fields })
if (!result.ok) this.checks.send('UNSENT')
else if (result.committed) { /* reset, confirm */ }
else this.checks.send('REFUSED')

// Checks machine
REFUSED: (s) => {
  s.refusal =
    'The desk refused this registration — the event may be sold out, or this email is already on the roster.'
},
```

After:

```ts
else this.checks.send({ type: 'REFUSED', refusal: result.refusal })

// Checks machine
REFUSED: (s, e) => {
  const at = (field: string) =>
    e.refusal?.issues?.find((i) => i.path[0] === field)?.message ?? null
  s.nameError = at('name')
  s.emailError = at('email')
  s.seatsError = at('seats')
  s.refusal = e.refusal?.message ?? (e.refusal?.issues ? null : 'The desk refused this registration.')
},
```

The template does not change: the same `<p role="alert">{read(checks, (c) => c.emailError)}</p>` lines show a server-found duplicate where they showed a client-found format error. The inputs are never written, so the visitor's typing stays (the forms guide's rule). `DeskMachine` still holds no context.

### A typed vocabulary

The log asked for "a guard-declared vocabulary", and a bare string compared in an island is the magic string the dispatch surface otherwise removed. Same carrier idiom as `events`:

```ts
defineMachine({
  name: 'DeskMachine',
  events: {} as DeskEvents,
  refusals: {} as 'invalid' | 'duplicate' | 'full',
  …
})
```

- `DefineMachineConfig` and `MachineDef` gain a trailing type parameter `Rc extends string = string`; `AnyMachineDef` gets the sixth `any`. `refuse`'s first argument is `Rc` in that machine's guards, so a typo is a compile error.
- `RefusalOf<D>` reads it back; `dispatch<D>()` returns `DispatchResult<RefusalOf<D>>`, and the API-route and app dispatch results do the same. The island's `result.refusal?.code === 'duplicat'` fails to compile.
- Omitted, everything is `string` and nothing is checked, which is the 3.1 behavior for every existing machine.
- It lands as its own PR after the untyped path works, and is the one piece of this spec that can be dropped without touching the rest.

### Client machines

A `machine()` client machine gets no `refuse` in its typed `on` map (`client/machine.ts` `TypedClientOnMap` guards take `(ctx, ev)`), and `use()`'s `send` keeps returning `void` (`client/use.ts:46`). A client machine's state is page-local by definition, so "write the error to context" has neither of the problems that rule it out on the server. A portable `defineMachine` machine run through `use()` can call `refuse`, because it is the same engine; the reason is dropped. Revisit on evidence.

### Where each piece lives

| Piece | File |
|---|---|
| `Refusal`, `RefusalIssue`, `GuardHelpers`, `Guard`, `RefusalOf`, `Rc` | `packages/stator/src/engine/types.ts` |
| `SendResult`, the per-send recorder | `packages/stator/src/engine/actor.ts` |
| `refusals` carrier | `packages/stator/src/engine/define-machine.ts` |
| exports | `engine/index.ts`, `client/index.ts` |
| `dispatchEvent`, subscriber debug log | `server/session-runtime.ts` |
| envelope, the 422, the `debug` log level for it | `server/http.ts`, `wire/index.ts`, `WIRE.md` |
| status in the replay cache | `server/event-dedupe.ts` |
| reading non-2xx bodies, `DispatchError.message`, `PostEventResult`, both window-event emitters | `client/transport.ts` |
| API route, app dispatch | `server/api-route.ts`, `server/routing.ts`, `server/app-dispatch.ts`, `server/create-app.ts` |
| completions and timers (log only) | `server/effects.ts`, `server/timers.ts` |
| island result, template sends, inspector rows | `client/dispatch.ts`, `client/runtime.ts`, `client/inspector.ts` |

## Alternatives Considered

- **Reason as machine state the engine writes** (a reserved `ctx.$refusal`, or a `lastRefusal` on the snapshot, read with `read()`). Rejected. It is state that no declared transition wrote, which is the objection that removed `@set`. It persists, so it survives a refresh (log entry 8). Clearing it needs either a second event or mutate-on-render, which the model forbids. And on a live route a `read()` of it would fan out one visitor's error to that session's other tabs.
- **A refusing transition that commits** (`{ refuse: …, do: … }`: write the error to context and report `committed: false`). Rejected: it makes `committed` mean "did what you asked" in one place and "transitioned" everywhere else (persist, fan-out, the replay cache, `getCommitCount`).
- **Guard returns `boolean | Refusal`.** Rejected for the truthiness hazard above. It also changes `Guard`'s return type under every existing annotated guard.
- **Guard returns `true | string`.** Same hazard, and no room for issues.
- **Throwing a `Refusal` from the guard.** Rejected: a guard that throws is a bug today and should stay distinguishable from a guard that says no. It would also skip later candidates in an array.
- **A transition-level `reject:` sibling to `when:`** (`reject: (ctx, ev) => Refusal | null`, run when no candidate passed). Rejected: the predicate that decides is then written twice, once to refuse and once to explain, and they drift.
- **A `refused()` template binding for server templates.** Rejected for now. It is a new binding kind with slot identity and scope rules, for a case that has no evidence: every form with fields is an island already, because template events carry nothing from the browser. The window event covers a server-template button that wants a toast.
- **HTTP 200 for a refusal** (this spec's first draft). Superseded by the decision record. Its argument was that the client transport treats any non-2xx as a failed POST; the answer was to fix the transport, which was discarding bodies the server already wrote for 400, 403 and 413. A status that says "the request was understood and refused" is also what a proxy log, a test's `res.ok` and a non-Stator client read without knowing the envelope.
- **422 for every `committed: false`.** Rejected: a bare refusal is usually a stale click, it carries nothing to show, and it would put a red console line on a benign race. It would also change the status of responses from machines that never opted in.
- **`ok: false` for a 422.** Rejected in the decision record: an island would need two paths for "the server said no" (one under `ok`, one under `!ok`), and `stator:dispatch-error` listeners would fire for a mistyped email.
- **A new `phase: 'protocol'` for a malformed body.** Rejected for now: widening the `phase` union breaks an exhaustive `switch` in app code. `phase: 'http'` with the status and a `message` says the same thing.
- **Retrying 502, 503 and 504.** The `eventId` makes it safe, and a restarting server answers exactly these. Left out: it changes the documented rule ("a status is never retried") and belongs to a connection-lifecycle design, not this one.
- **Report every candidate's refusal as a list.** Rejected as surface with no consumer. First-recorded is deterministic and is what one guard produces.

## Open Questions

- **First refusal or last, across a candidate array?** First is specified. Last has an argument (the final candidate is the fallback, so its reason is "why nothing matched"). No real machine in the repo has two reasoned candidates yet.
- **Should an event the current state does not handle carry a framework code** (`'unhandled'`)? It would let a client tell "the guard said no" from "not now". Left out: it is a code no app declared, and the agent-tools availability pipeline already answers "not now" before the call.
- **`data` on a refusal** (`{ code: 'full', data: { left: 2 } }`), for client-owned wording and i18n. Wait for the i18n investigation (ROADMAP) or a second app.
- **Server-template forms.** With 3.2 schemas, `on:submit` could collect `FormData` into the event and the schema would check it, removing the island from a simple form. That needs string coercion and a way to show issues without an island, which is the binding this spec declines. Recorded as the follow-up question, not designed.
- **Should a 4xx from an API route have its envelope applied by an enhanced form?** A handler that answers 422 with `{ directives: [...] }` gets its body dropped today. Reading the `error` string is specified here; applying an envelope on a non-2xx is not, because no app has asked and API-route envelopes are 200 by construction (`server/api-route.ts`).
- **Should the 400's `detail`** (a Zod dump for a malformed envelope, `http.ts:703`) reach `DispatchError`? Specified as no: it is for the console, and it is the framework's wording, not the app's.
- **Island dispatches are missing from the inspector's wire log.** `stator:event-sent` and `stator:patches-received` are fired by the page runtime only (`runtime.ts:341`, `:407`); `dispatch()` fires neither, so a refused island dispatch shows as a refusal row with no send above it. Moving both emits into the shared transport is small and additive. Tracked in [[client-side-event-error-handling]].
- **`use()` send returning `SendResult`.** One line, but it is surface. Waiting on a client machine that wants it.

## Implementation Notes

Six PRs, in order. PR 1 touches no file the engine work touches, stands alone, and ships first: it is worth having even if nothing after it lands, because it is what lets app code read the 400, 403 and 413 sentences the server already writes.

**PR 1 — the client reads 4xx bodies (S).** `client/transport.ts`: `DispatchError.message`, `PostEventResult` carries the parsed envelope and the status, the six rules under "The client", the 422-with-refusal branch (dormant until PR 3: no server sends one yet). `client/dispatch.ts`: consume the envelope, no unguarded `res.json()`, the new `ok` doc comment. `client/runtime.ts`: `dispatchEvent` consumes the envelope; `submitForm` passes a JSON `error` through as `message`; `applyEnvelopeFromResponse` loses its only `/__events` caller and stays for `submitForm`. `client/inspector.ts`: the message on the `✕` row. Tests: `tests/client-dispatch.test.ts` (a 403 with `{ error }` gives `error.message`; a 500 with a text body gives no message, which is today's assertion at `:64` unchanged; a 200 with a non-JSON body resolves `ok: false` and does not reject; a 422 with a refusal body gives `ok: true`, `committed: false`, and fires no `stator:dispatch-error`; a 422 with `{ error }` gives `ok: false`), `tests/runtime-dispatch.test.ts` (the 500 case at `:159` and the form 422 case at `:219` pass unchanged, both assert partially; add the message on the event detail; a 4xx is not retried). Docs: `reference/client.md` (`dispatch`, the window-events paragraph, the retries paragraph), `guides/dispatching-events.md` ("Failure and retry semantics", the `ok` and `error` bullets), `concepts/events-and-dispatch.md:48`. `WIRE.md`: bring the error table up to what the server answers today. Changeset: minor (`DispatchError.message` is new surface).

**PR 2 — engine (S).** `engine/types.ts`: `Refusal`, `RefusalIssue`, `GuardHelpers`, `Guard`'s third parameter. `engine/actor.ts`: `SendResult`, the recorder, the three rules. `engine/index.ts` exports. Tests in `tests/engine.test.ts`: refuse returns false and the result carries it; first-wins; a passing later candidate drops it; unhandled event has none; `refuse` then `return true` commits with none; machine-level `on` fallback (`tests/machine-level-on.test.ts`); a guard typed against `ActionHelpers` still assigns (`tests/*.test-d.ts`); a Standard Schema issue list maps into `issues`. Changeset: minor; says the engine hash moves once.

**PR 3 — hosts and wire (M).** `server/session-runtime.ts` (`dispatchEvent`), `server/http.ts` (envelope, the 422, replaying the cached status, the request logger's level for a 422 on `/__events`, the subscriber debug log), `server/event-dedupe.ts` (status beside the body), `wire/index.ts`, `WIRE.md`, `server/api-route.ts`, `server/routing.ts`, `server/app-dispatch.ts`, `server/create-app.ts`, `server/effects.ts`, `server/timers.ts`. Tests: `tests/http.test.ts` (a refusal is a 422 with the envelope; a guard that returns `false` with no reason is a 200 and its body is byte-identical to a recorded 3.0.3 body; every row of the status table that exists today keeps its status and body), `tests/events-idempotency.test.ts` (a retried refused event replays the same body **and** a 422; a retried committed event still replays a 200; an entry recorded without a status replays as 200), `tests/event-gate.test.ts` and `tests/server-only-events.test.ts` (an unoffered or server-only event gets its 403 and no `refusal` key), `tests/runtime-dispatch.test.ts` (API-route result), `tests/app-machine-events.test.ts` (`dispatchToApp` result; a subscriber's refusal does not reach the origin's caller).

No existing test asserts a 200 on a path that becomes a 422, because no machine in the repo calls `refuse` until PR 6. The assertions that will move are in the starter and are listed there.

**PR 4 — client refusals (S).** `client/dispatch.ts` (`refusal` on the result), `client/transport.ts` (`stator:dispatch-refused`), `client/runtime.ts` (fire it for template sends), `client/index.ts` (exports), `client/inspector.ts` (the refused row and its code). Tests: `tests/client-dispatch.test.ts` (the result table above, row by row), `tests/client-runtime.test.ts` (a template send answered 422 fires `stator:dispatch-refused` with the refusal, fires no `stator:dispatch-error`, and clears `data-stator-pending`; a bare `committed: false` fires it with no refusal).

**PR 5 — typed vocabulary (S/M, droppable).** `engine/types.ts`, `engine/define-machine.ts`, `client/dispatch.ts`, `server/routing.ts`, `server/app-dispatch.ts`. Tests are type tests: a `tests/refusals.test-d.ts` beside `client-types.test-d.ts` (typo in `refuse`, typo in the island comparison, omitted carrier stays `string`, inference of `C`/`E`/`S` unchanged with the carrier present). The risk is `defineMachine`'s inference, which is already delicate (`define-machine.ts:60-66`, the `NoInfer` note); the carrier is a plain property like `events`, so it should not add inference candidates, and the type tests are there to prove it.

**PR 6 — starter and docs (M).** `examples/registration`: `machines/desk.ts` (reasons on `REGISTER`, `UPDATE`, `SET_SEATS`), `lib/rules.ts` (`registrationIssues`), `templates/reg-form.stator`, `templates/row-seats.stator`; close entry 1 in `.chisel/docs/registration-paper-cuts.md`. `tests/wire.test.ts` is where the status change is visible: `sendForPatches` asserts `res.status === 200` (`:82`) and the wrong-type loop at `:286-294` calls it for events the desk will now refuse with `'invalid'`, so that helper returns the status and the loop asserts 422 and the code; the duplicate, sold-out and taken-email cases (`:124-132`, `:151`, `:213`) read only the JSON and gain assertions on the status and `refusal.code`. Docs: `guides/forms-and-inputs.md` ("the machine's guards run server-side" paragraph, and a section on server-found errors), `guides/dispatching-events.md` (`DispatchResult`, the status a refusal answers with), `concepts/events-and-dispatch.md`, `reference/machine.md`, `reference/client.md`, `reference/server.md`, `guides/api-routes.md`, `recipes/receiving-webhooks.md` (`committed` as the duplicate signal becomes the code), the production guide (leave `/__events` error bodies alone at the proxy), `tutorial/05-handling-events.md` (its failure paragraph names only `stator:dispatch-error`). ROADMAP: move the Primitives entry to the record line.

Nothing here is deferred to 4.0. No cutover is recorded for this feature.

## Decision record (2026-11-22, Tony)

- A refusal is transient data on the dispatch result, originated by `helpers.refuse()` in a guard. Accepted as specced.
- Accepted as recommended: the `stator:dispatch-refused` window event for server-template sends; the typed `refusals:` vocabulary as the last, droppable PR; the first refusal wins across candidates; an event unhandled in the current state carries no refusal; client machines get no `refuse` in 3.1.
- **Status codes (supersedes the 200 in "The wire" above).** A response that carries a `refusal` is a 422. A bare `committed: false` with no reason stays 200. The client reads the JSON body of a non-2xx `/__events` response instead of discarding it (`client/transport.ts`), so the server's existing 400 / 403 / 413 messages reach app code too. `DispatchResult.ok` is `true` for a 422 refusal: `ok` means the server processed the event and answered, and `stator:dispatch-error` stays for transport and protocol failures. The red console line for a refused form is accepted.
- How app code handles event errors beyond the dispatch result (in the machine, or an error-boundary-style scope) is a follow-up design: see the client event error handling spec.
