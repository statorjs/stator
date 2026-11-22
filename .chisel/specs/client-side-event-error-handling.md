---
title: Client-side event error handling
status: draft
created: 2026-11-22
updated: 2026-11-22
area: client
---

## What and Why

A visitor clicks something and it does not work. What they see today is, in most cases, nothing.

[[refused-dispatch-reasons]] (3.1) fixes what the **data** looks like: a guard can say why, a refusal is a 422, and the client reads the body of a non-2xx response where it used to discard it. Its decision record leaves one question to this spec, in the owner's words: "how client code could be hardened allowing users to author their own client-side error handling. That could be future work, and it could be as simple as handling it in the machine or more complex like an error boundary type of approach to catch any event errors within a scope."

This spec maps that spectrum, says where each rung would live in Stator's model, and recommends a staging. The short version:

- The simple end (an island feeds the result to its client machine) already works and needs no new surface. It needs the 3.1 result shape and a docs page.
- A page with **no island** has no way to show a failure at all, and no example in the repo tries. That is the real gap, and the smallest thing that closes it is one runtime-owned attribute beside `data-stator-pending`.
- The complex end, a scope that catches failures in a subtree, does not need a boundary primitive. The DOM is already the scope tree: fire the failure events from the element that sent, let them bubble, and any ancestor is a boundary. That is a change to where two events are dispatched, not a new binding.
- A React-style boundary that swaps a subtree for a fallback is the wrong shape here, because the server owns the subtree. The cases it exists for (a render that throws) have different remedies in Stator: resync, or a 500 page.

### What exists today

Verified in code at 3.0.3. "Sees" means what a visitor sees with no app code written for the case.

**The pieces.**

- `stator:dispatch-error`, a `CustomEvent` on `window`, fired once per final failure with `{ machine?, event?, phase: 'network' | 'timeout' | 'http', status?, timestamp }` (`client/transport.ts:41-46`, `:108`). `machine` is absent for enhanced form submits (`client/runtime.ts:379`, `:384`).
- `data-stator-pending` on the element whose POST is in flight, cleared on every path including failure (`client/runtime.ts:35-48`, `:349-355`). It is the only per-element signal, and a failure erases it.
- `data-stator-connection` on `<html>` (`connected`, `disconnected`, `stale`, `idle`) and `stator:connection-state`, for live routes only (`client/runtime.ts:100-105`).
- Island `dispatch()` resolves to `{ ok, committed, patchCount, error? }` (`client/dispatch.ts:7-18`). An island can branch on it; the registration form does (`examples/registration/templates/reg-form.stator`, `UNSENT` and `REFUSED` into its `Checks` client machine).
- A template send returns nothing to anyone. `handleEvent` calls `void dispatchEvent(descriptor, el)` (`client/runtime.ts:332`), the event carries nothing from the browser (`wire/template-events.ts`), and the only trace of a failure is the window event.
- The dev inspector lists `stator:dispatch-error` as a `✕` row (`client/inspector.ts:479`). It is dev-only, and it does not see island dispatches at all: `stator:event-sent` and `stator:patches-received` are fired by the page runtime (`runtime.ts:341`, `:407`), not by `dispatch()`.
- No example or app in the repo listens for `stator:dispatch-error` or `stator:connection-state`. Four of them style `data-stator-pending` and `data-stator-connection` in CSS (`apps/store`, `examples/desksmith`, `examples/live-poll`, `examples/weather`). Every template button in every example fails silently.

**Every failure after a click.**

| # | What happened | What the framework does today | Visitor sees |
|---|---|---|---|
| 1 | A guard refused, or the current state does not handle the event | 200, `committed: false`, no patches. No event, no log. (3.1: `stator:dispatch-refused`; a 422 when the guard gave a reason.) | Nothing |
| 2 | Turned away before the machine: unoffered event, `serverOnly`, app machine, cross-site (403); malformed (400); unknown route or machine (404); oversize (413) | `console.error`, `stator:dispatch-error` with the status. The JSON `error` body is discarded (`transport.ts:95`). (3.1: it arrives as `error.message`.) | Nothing |
| 3 | The page's middleware would redirect this caller (signed out mid-session) | 200 with a `navigate` directive (`server/http.ts:677`) | Lands on the sign-in page. Works. |
| 4 | The page's middleware refuses this caller outright (401, 403) | `{ error: 'not admitted to this route' }` with that status; then as row 2 | Nothing |
| 5 | The session's state is gone (store TTL elapsed, cookie cleared) | No error. `getOrCreateSessionId` resumes or mints an id (`server/session.ts:147`), the machines load at their initial state, and the event runs against that. It may commit against an empty cart or come back `committed: false`. The POST diffs fresh state against fresh state, so the patches cover only what the event changed. | A page that is stale everywhere the event did not touch. On a live route the next reconnect's sync converges it; on a non-live route nothing does until a navigation. Inferred from the code, not reproduced. |
| 6 | A guard, action or render threw on the server | 500 with Hono's default text body (there is no `onError`); then as row 2 | Nothing |
| 7 | Offline, or the server is unreachable | `fetch` rejects; retried after 300 ms and 1 s with the same `eventId` (`transport.ts:20`, `:99-106`); then `console.error` and `stator:dispatch-error` with `phase: 'network'`. Nothing consults `navigator.onLine`. | `data-stator-pending` for about 1.3 s, then nothing |
| 8 | The server is too slow | Each attempt aborts at 10 s (`transport.ts:16`), three attempts; then `phase: 'timeout'` | `data-stator-pending` for about 31 s, then nothing |
| 9 | A 200 whose body is not JSON | Page runtime: `console.error('stator: malformed response')`, no event (`runtime.ts:402`). Island: `res.json()` is unguarded (`dispatch.ts:43`), so `dispatch()` rejects, which the docs say it never does. | Nothing; in an island, an unhandled rejection |
| 10 | A patch names a slot or element that is not in the DOM | `console.warn`, the patch is skipped, `stator:patch-applied` fires with `element: null` (`wire/apply.ts:34-40`) | A page that has quietly stopped matching the server |
| 11 | Applying a patch throws | `applyPatches` has no `try` (`wire/apply.ts:57-60`). From a POST: the rest of the batch and all directives are dropped and the promise from `void dispatchEvent(...)` rejects unhandled. From SSE: the exception leaves the `message` listener; later frames still apply. | The same as row 10, possibly worse |
| 12 | An unknown directive, or an unsafe `navigate` target | `console.error`; an unsafe `navigate` also stops the remaining directives (`wire/apply.ts:115-118`) | Nothing |
| 13 | A deploy while the page is open, live route | The next `/__sse` connect carries the old build id and is answered with a `reload` directive (`server/http.ts:565`) | The page reloads. Anything typed into an input and any client-machine state is lost, without a word. |
| 14 | A deploy while the page is open, non-live route | Nothing checks: `/__events` reads no build id. The old page keeps posting. A changed template shows up as row 10, a removed event as row 2. | Nothing, or a half-updated page |
| 15 | The live channel drops | `data-stator-connection="disconnected"`, `stator:connection-state`; `EventSource` reconnects on its own and the initial sync converges the DOM. Directives pushed during the outage are gone (`runtime.ts:140-146`). Clicks still POST, on their own connection. | An offline banner, if the app wrote the CSS for it |
| 16 | The live channel is refused (the session lost admission; `/__sse` answers 401 or 403 as text, `server/http.ts:531-536`) | `EventSource` does not retry a non-200 (from memory, per the HTML spec); `console.warn('stator: SSE permanently closed')`. The stale watchdog rebuilds the connection about every 65 to 75 s (`runtime.ts:179-187`), and each rebuild is refused again. No `navigate` is sent. | The offline banner, forever, on a page that is not offline |
| 17 | An island's handler throws, or its async handler rejects | Nothing catches it. The compiler wires `node.addEventListener(event, handler)` with no wrapper (`compiler/client-emit.ts:105`); the error goes to `window.onerror` or `unhandledrejection`. The island stays mounted. | Nothing |
| 18 | An enhanced form submit (`data-stator-enhance`) gets a non-2xx | `console.error`, `stator:dispatch-error` with no `machine`; the body is discarded (`runtime.ts:382-386`) | Nothing |

Four different things are in that table, and the rest of this spec keeps them apart:

- **A. Refusals** (row 1). The machine answered no. Expected, routine, and the sender's business.
- **B. Delivery failures** (rows 2, 4, 6 to 9, 18). The event did not reach a machine, or the answer did not arrive.
- **C. Divergence** (rows 5, 10, 11, 13, 14). The page no longer matches the server. Often no single click caused it.
- **D. Client code faults** (row 17). A bug in an island's script.

Rows 15 and 16 are connection state, a fifth thing. It is adjacent and gets its own design (see "Connection state" below).

## Success Criteria

- A page with no island can show, next to the control that was used, that an action was refused or did not go through, with no script.
- An app can handle refusals and delivery failures for one part of a page differently from the rest (a checkout panel that explains itself; a toast for everything else), with no new template syntax.
- An island handles all four result cases (committed, refused with a reason, refused without one, not delivered) through its client machine, and the docs show the pattern once.
- A failure is reported once. A listener written against 3.0 for `stator:dispatch-error` on `window` keeps working and does not start firing for refusals.
- A patch that throws does not take the rest of its batch or the response's directives with it, and it is observable.
- Nothing in 3.1 adds a binding kind, a template directive, a slot or element-id rule, or a new argument to `dispatch()`.
- Each thing left out has a named trigger for promoting it.

## Constraints

- Non-breaking minors. The two window events keep their names and their detail fields; listeners on `window` keep receiving them.
- No convenience primitive ahead of evidence (the reason `bind:` was removed). The evidence that exists: one starter's form island (registration), and the fact that no example handles a failed template send.
- Nothing at the compose and identity seam: no new binding kind, no boundary region, no slot scope. That rules out a template-level boundary until something forces it.
- The server owns server-rendered DOM. A client mechanism may set an attribute the runtime owns; it may not replace a subtree the server will patch.
- An error message that only the sender needs is not machine state ([[refused-dispatch-reasons]], "Doctrine"; registration log entry 8). This spec does not reopen that.
- Depends on [[refused-dispatch-reasons]] PR 1 (the client reads 4xx bodies) and PR 4 (`stator:dispatch-refused`).

## Approach

Four rungs, simplest first. Each is stated with what it costs, a code sample, and when it should ship.

### Rung 0: the result and the events are complete (3.1, already specified)

This is [[refused-dispatch-reasons]]: `result.refusal`, `result.error.message`, `stator:dispatch-refused`. Three additions belong with it. None is new surface; each is a row of the table above behaving as documented.

1. **`dispatch()` never rejects** (row 9). Falls out of the transport parsing the body; already in that spec's PR 1.
2. **A throwing patch is contained** (row 11). `applyPatches` wraps each patch: on a throw it logs, fires `stator:patch-error` on `window` with `{ patch, error, timestamp }`, and continues with the next patch. Directives still run. The inspector lists it.

   ```ts
   // wire/apply.ts
   for (const patch of patches) {
     let element: Element | null = null
     try {
       element = applyPatch(patch, regionFor)
     } catch (error) {
       console.error('stator: patch failed to apply', patch, error)
       emit('stator:patch-error', { patch, error, timestamp: Date.now() })
       continue
     }
     emit('stator:patch-applied', { patch, element, timestamp: Date.now() })
   }
   ```

   A keyed-list batch is positional, so continuing after a failed `insert` can misplace later ops. That is still better than dropping them: on a live route the next sync resets the list wholesale, and the alternative leaves the list and every directive unapplied.
3. **Island dispatches appear in the inspector.** `stator:event-sent` and `stator:patches-received` move from `runtime.ts` into the shared transport path so `dispatch()` fires them too. Without this a refused island dispatch is a refusal row with no send above it.

### Rung 1: handle it in the machine (works today; a docs page in 3.1)

An island has the result in hand and a client machine to put it in. This is the registration pattern, and after 3.1 it covers every case with no new API:

```ts
async submit(e: Event) {
  e.preventDefault()
  const result = await dispatch(DeskMachine, { type: 'REGISTER', ...this.fields() })
  if (!result.ok) this.checks.send({ type: 'UNSENT', error: result.error })
  else if (result.committed) this.checks.send({ type: 'CONFIRMED', name: this.fields().name })
  else this.checks.send({ type: 'REFUSED', refusal: result.refusal })
}

// the client machine
REFUSED: (s, e) => {
  const at = (field: string) => e.refusal?.issues?.find((i) => i.path[0] === field)?.message ?? null
  s.nameError = at('name')
  s.emailError = at('email')
  s.refusal = e.refusal?.message ?? (e.refusal?.issues ? null : 'The desk refused this registration.')
},
UNSENT: (s, e) => {
  s.refusal =
    e.error?.phase === 'http'
      ? 'The desk turned this away. Reload the page and try again.'
      : "The desk couldn't be reached, so nothing was saved. Try again."
},
```

```astro
<p role="alert">{read(checks, (c) => c.emailError)}</p>
<p role="alert" data-refusal>{read(checks, (c) => c.refusal)}</p>
```

The message is client-machine state, so it dies with the page (log entry 8), the inputs are never written, and it is reset by the machine's own events (`CHECK_EMAIL` clears `refusal` today).

**Is a piece missing?** Two candidates, both declined for 3.1:

- *A typed helper for issues*, such as `issueAt(refusal, 'email')` or `fieldErrors(refusal)`. The `at` closure above is three lines and the starter is its only user. Promotion trigger: a second app copies it (`planning-poker` and the indie-blog no-navigation form are the next two forms).
- *A conventional event* that `dispatch()` would send to a client machine itself (`dispatch(Desk, event, { into: this.checks })`). Declined: it hides the one branch the docs most want visible ("buttons that say done should be looking at `committed`"), and it is a second way to do what three lines do.

What 3.1 adds for this rung is documentation: one guide section, "When an event doesn't go through", with the four-way branch and the two machine handlers. `UNSENT` and `REFUSED` become the names the docs use, as a convention and nothing more.

### Rung 2: a page with no island (one attribute, 3.1)

A server-template button has no script and no machine on the client. The window events exist, but something has to listen, and the only place app script lives is an island. So "show that it failed" currently costs an island, and no example pays it.

The framework already owns one per-element signal, `data-stator-pending`, and already removes it on failure. The proposal is its sibling:

> **`data-stator-failed`** is set on the element whose send did not succeed, and removed when that element sends again. Its value is `refused` (a 422 with a refusal) or `error` (anything that fires `stator:dispatch-error`).

The rule for when it is set follows the status decision exactly: **a non-2xx answer or no answer sets it; a 200 never does.** A bare `committed: false` is a stale click and stays silent; a guard that called `refuse()` wanted the sender to know.

```astro
<div class="pay">
  <button on:click={() => cart.send({ type: 'CHECKOUT' })}>Pay</button>
  <p class="pay-failed" role="status">That didn't go through. Check your connection and try again.</p>
  <p class="pay-refused" role="status">The cart changed while you were away. Review it and try again.</p>
</div>
```

```css
.pay-failed, .pay-refused { display: none; }
.pay:has([data-stator-failed='error']) .pay-failed { display: block; }
.pay:has([data-stator-failed='refused']) .pay-refused { display: block; }
button[data-stator-failed] { outline: 2px solid var(--danger); }
```

`:has()` makes any ancestor a scope with no framework involvement, which is most of what rung 3 is asked for. The messages are server-rendered text in the template, so they are translated and styled like the rest of the page.

Implementation is about ten lines in `client/runtime.ts`: `beginPending` removes the attribute; the failure and refusal paths set it. It applies to `data-event-*` elements and to forms (`data-event-submit` and enhanced submits). It is not set for island `dispatch()`, which has no element and has the result.

Limits, stated in the docs:

- It cannot show the refusal's own `message` or `issues`. Text that depends on the reason needs rung 1 or the recipe below. (A `data-stator-refusal="<code>"` attribute would let CSS pick a message per code. Left as an open question.)
- An element that becomes visible through CSS is not reliably announced by screen readers the way inserted text in a live region is (from memory; behavior varies by reader). A page where that matters uses the recipe below, which writes text into a `role="alert"` element.
- If a patch replaces the region holding the element, the attribute goes with it. That is the right lifetime: the thing it described is gone.

**Why this clears the evidence bar when `bind:` did not.** It is not a new way to write something that could already be written; without an island there is no way at all. The evidence is four examples that style the pending half of this affordance and none that handle its failure half, plus the 4xx decision itself, which makes "the server said no to a template button" a first-class answer that the page then drops. It adds no syntax and no identity rule: it is an attribute the runtime sets on an element it already marks.

**The recipe for everything the attribute cannot do** (docs, 3.1): one island in the layout that turns the two window events into text.

```astro
<fault-toast>
  <p role="alert">{read(fault, (f) => f.message)}</p>
</fault-toast>

<script>
  const Fault = machine(
    { message: null as string | null },
    {
      events: {} as { type: 'FAILED'; message: string } | { type: 'CLEARED' },
      on: {
        FAILED: (s, e) => { s.message = e.message },
        CLEARED: (s) => { s.message = null },
      },
    },
  )

  export class FaultToast extends StatorElement {
    fault = use(Fault)

    connectedCallback() {
      super.connectedCallback()
      const refused = (e: Event) => {
        const { refusal } = (e as CustomEvent).detail
        if (refusal) this.fault.send({ type: 'FAILED', message: refusal.message ?? "That wasn't accepted." })
      }
      const failed = () => this.fault.send({ type: 'FAILED', message: "That didn't go through. Try again." })
      const cleared = () => this.fault.send('CLEARED')
      window.addEventListener('stator:dispatch-refused', refused)
      window.addEventListener('stator:dispatch-error', failed)
      window.addEventListener('stator:event-sent', cleared)
      this.track(() => {
        window.removeEventListener('stator:dispatch-refused', refused)
        window.removeEventListener('stator:dispatch-error', failed)
        window.removeEventListener('stator:event-sent', cleared)
      })
    }
  }
</script>
```

It ignores a bare refusal (no `refusal` in the detail), for the same reason the attribute does. It resets on the next send, which needs `stator:event-sent` to fire for island dispatches too (rung 0, item 3).

### Rung 3: a scope that catches failures in a subtree

**What the scope could be**, in Stator's model:

| Candidate | Exists at runtime? | Verdict |
|---|---|---|
| A component | No. A component compiles away; nothing in the DOM or the wire marks where one began. | Would need a marker, which is the next row. |
| A region marker (a new `boundary` binding beside `when` / `each`) | Would be new: a slot id, scope rules, an interaction with keyed lists and subsumption. | The compose and identity seam. Not without evidence that nothing smaller works. |
| A route or layout | Yes: the page. | This is the window listener that exists. It is a scope of one. |
| An island | Yes, an element with a lifecycle. But server-rendered content does not flow through an island (`guides/client-components.md`: "a deliberate boundary"), so an island cannot wrap an arbitrary piece of a server template. | A boundary for its own template only. |
| **Any DOM element** | Yes. | The scope tree the platform already has. |

**The proposal: fire the events where the click happened.** `stator:dispatch-refused` and `stator:dispatch-error` are dispatched on the element that sent, with `bubbles: true`, and reach `window` by bubbling. A listener on any ancestor is a boundary; `stopPropagation()` is "handled here, do not also toast".

```ts
// client/transport.ts
function emitFrom(el: Element | undefined, name: string, detail: unknown): void {
  const target = el?.isConnected ? el : window
  target.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }))
}
```

- The `isConnected` check matters: a patch can remove the button while its POST is in flight, and an event dispatched on a detached node never reaches `window`.
- Island `dispatch()` has no element and keeps dispatching on `window`. An island has the result; it is its own boundary. (An optional `from` argument is the obvious extension and is not proposed.)
- Existing `window` listeners receive exactly what they receive today. The one observable difference is `event.target`, which was `window` and becomes the element.
- `stator:event-sent` gets the same treatment, so a scope can reset when something inside it is tried again.

With that, a scoped boundary is the toast recipe listening on an ancestor instead of `window`. A page-level island delegates by attribute, so the server template stays free of islands:

```astro
<section data-fault-scope>
  {each(cart.lines, (line) => (
    <button on:click={() => cart.send({ type: 'REMOVE', id: line.id })}>remove</button>
  ), { key: (l) => l.id })}
  <p role="alert" data-fault></p>
</section>

<fault-scopes />   <!-- once, in the layout -->
```

```ts
export class FaultScopes extends StatorElement {
  connectedCallback() {
    super.connectedCallback()
    const say = (e: Event, text: string | null) => {
      const slot = (e.target as Element).closest?.('[data-fault-scope]')?.querySelector('[data-fault]')
      if (!slot) return                // no scope around this one: let the page toast have it
      slot.textContent = text
      e.stopPropagation()
    }
    const refused = (e: Event) => {
      const { refusal } = (e as CustomEvent).detail
      if (refusal) say(e, refusal.message ?? "That wasn't accepted.")
    }
    const failed = (e: Event) => say(e, "That didn't go through. Try again.")
    const sent = (e: Event) => say(e, null)
    document.addEventListener('stator:dispatch-refused', refused)
    document.addEventListener('stator:dispatch-error', failed)
    document.addEventListener('stator:event-sent', sent)
    this.track(() => { /* remove the three */ })
  }
}
```

(`sent` should clear without stopping propagation; the sample is abbreviated.) This is client code writing text into a server-rendered element, which the client-components guide sanctions for regions the server does not bind ("plain platform tools"). The `<p data-fault>` must carry no `read()`.

**What a scope catches, precisely.**

| Class | Caught by a scope? | Why |
|---|---|---|
| A. Refusals | Yes, when a reason was given | Per action, per element; locality is the point. A field-level error still belongs to the form's island (rung 1), not a scope. |
| B. Delivery failures | Yes | Same shape: one action, one element. |
| C. Divergence (missing or throwing patch, stale session, stale build) | **No** | No element caused it and no subtree contains it. The remedy is to converge with the server, not to render a fallback: on a live route, rebuild the channel and take the initial sync; on a non-live route, reload. `stator:patch-error` on `window` makes it observable. Whether the runtime resyncs by itself is an open question. |
| D. Island script faults | **No** | A different mechanism. A scope for these would be a wrapper the compiler puts around every island handler, plus a decision about what an island renders when its own code is broken. See below. |
| Server render errors | Not a client concern | A route that throws on GET is a 500 response. A route-level error page (a `500.stator` beside the `404` fallback) is the SvelteKit `+error` analog and a separate, server-side design. |

**What it renders.** A message in an element the scope names. Never a replacement for the subtree: the server will patch that subtree on the next commit, and a client fallback would either be overwritten or leave the patch with no target (row 10).

**How it resets.** On the next `stator:event-sent` from inside the scope. If the server replaces the region that holds the message element, the message goes with it. A keyed row keeps its element across reorders (WIRE.md, keyed lists), so a per-row scope keeps its message until that row is tried again or removed.

**Server-pushed patches** do not interact with it otherwise. A push that changes the thing the message was about (the seat count the refusal mentioned) does not clear the message; the visitor's next attempt does. That matches a form: a stale error stays until you act.

**How other frameworks split this** (all from memory, not verified for this spec):

- *React.* Error boundaries catch errors thrown while rendering, in lifecycle methods and in constructors of the subtree. They do not catch event handlers, async code or server rendering. Reset is by remounting (a changed `key`) or boundary state. A mutation that fails is ordinary state.
- *SvelteKit.* `+error.svelte` is the nearest route-level page for errors thrown in `load` or render. `handleError` (server and client hooks) sees unexpected errors and returns the safe shape shown to the user. A form action that fails validation returns `fail(422, data)`, which arrives as the page's `form` prop and never reaches `+error`. Svelte 5 adds `<svelte:boundary>` for render-time errors in a subtree.
- *Remix / React Router.* A route's `ErrorBoundary` catches what its loader, action or render throws; the nearest route up the tree handles it. Validation errors are **returned** from the action and read with `useActionData`; throwing is for the unexpected.
- *Phoenix LiveView.* A crash kills the process and the client remounts the view from `mount` (forms recover by replaying their change event). Messages are `put_flash`. The client sets `phx-loading`, `phx-error` and connection classes on the view's container, and per-binding loading classes on elements. Validation errors are a changeset in assigns, rendered like any state.
- *Hotwire / Turbo.* A form response with a 4xx or 5xx status is rendered in place, which is how a 422 re-renders the form with its errors. `turbo:fetch-request-error` fires on a network failure and `turbo:submit-end` carries `success`. Events bubble from the form or frame.
- *htmx.* A 4xx or 5xx is not swapped by default; `htmx:responseError` and `htmx:sendError` fire on the triggering element and bubble. `htmx:beforeSwap` (or the response-targets extension) opts a 422 into being swapped. `hx-on:` listens inline, so an ancestor is a scope.
- *Livewire.* Validation errors are component state (the error bag, `@error`). A failed request shows the error page in a modal by default, a 419 offers a reload, request hooks can intercept failures, and `wire:offline` toggles elements.

Two things are common to all seven. Every one keeps the **expected** failure (validation, a refusal) out of its error boundary and delivers it as data or state next to the form. And the four server-driven ones (LiveView, Turbo, htmx, Livewire) expose the **unexpected** failure as DOM events and classes or attributes on the triggering element, not as a component boundary. Stator is in the second group. Rungs 2 and 3 are that group's answer: an attribute on the element and an event that bubbles from it.

### Island script faults (not proposed)

For completeness. The compiler could wrap each `on:` handler it wires (`client-emit.ts:105`) so a throw or a rejected promise fires a bubbling `stator:island-error` from the island's element. It is cheap and it would make row 17 observable to the toast recipe. It is not proposed because `window.onerror` and `unhandledrejection` already report these to whatever error tracker an app runs, the island stays mounted and usable after a handler throws, and there is no evidence of an island dying quietly in a way those two do not catch. Promotion trigger: such a report.

### Connection state: a separate design

Offline and reconnecting UI is adjacent and does not belong here. It is page-level, long-lived state with its own vocabulary (`data-stator-connection`), not the outcome of one event. It also has its own open problems that this spec's mechanisms do not touch: a refused live channel that reads as an outage forever (row 16), no use of `navigator.onLine`, a reload on build mismatch that discards typed input without warning (row 13), nothing at all on non-live routes (row 14), and whether a send made while disconnected should be held. ROADMAP already names a "presence / connection-lifecycle" gap with `planning-poker` as its scout; these go there.

One line of contact: during an outage a visitor gets both a `disconnected` banner and, if they click, a delivery failure. The recipes show the failure message regardless; an app that wants one voice hides the toast under `html[data-stator-connection='disconnected']`.

Session expiry (row 5) is likewise its own question. The server cannot cheaply tell an expired session from a new visitor, and the fix is as likely a build id or a state version on `/__events` as anything on the client.

### The staging

| When | What | Kind |
|---|---|---|
| 3.1, with the 4xx work | Rung 0: `dispatch()` never rejects; a throwing patch is contained and fires `stator:patch-error`; island dispatches fire `stator:event-sent` and `stator:patches-received` | Hardening |
| 3.1 | Failure events are dispatched from the sending element and bubble | Where two events fire |
| 3.1 | `data-stator-failed` | One runtime-owned attribute |
| 3.1 | Guide section "When an event doesn't go through": the island branch (rung 1), the attribute and `:has()` (rung 2), the toast and the scope recipes (rungs 2 and 3) | Docs |
| On evidence | An issues helper (`issueAt`) | Trigger: a second app copies the closure |
| On evidence | A shipped toast or scope island in `@statorjs/stator/components` | Trigger: two apps copy the recipe unchanged |
| On evidence | `data-stator-refusal="<code>"` | Trigger: a no-island page that needs per-reason text |
| On evidence | A template-level boundary or `refused()` binding | Trigger: server-template forms (the 3.2 follow-up where `on:submit` collects `FormData`), which would be the first forms with field errors and no island |
| On evidence | Island fault capture | Trigger: a report of an island failing silently past `window.onerror` |
| Separate designs | Connection lifecycle; session expiry; a route-level 500 page | |

If only one of the 3.1 rows ships beyond hardening, it should be the bubbling target. It is the one that is cheaper now than later: `stator:dispatch-refused` is new in 3.1, and deciding where it fires after it has shipped means changing `event.target` on a public event.

## Alternatives Considered

- **A `<stator:boundary>` region in the template language**, with a fallback arm rendered when a send inside it fails. Rejected for now. It is a new binding kind with a slot id, a scope and rules for keyed rows and subsumption, which is the standing complexity risk. Its fallback arm would have to be rendered by the client from a template the client does not have, or pre-rendered hidden, which is what `:has([data-stator-failed])` already does with no syntax.
- **A React-style boundary that replaces the subtree.** Rejected. The cases it exists for are render errors, and in Stator a render error is a server 500 or a patch that fails to apply. Replacing server-owned DOM with a client fallback breaks the next patch's targets.
- **A `refused()` template binding** that renders the last refusal for a machine. Already rejected in [[refused-dispatch-reasons]]; the argument holds. It becomes worth reopening when server-template forms exist.
- **Errors as machine state** (`ctx.error`, a flash read once). Rejected twice in the registration log and again in the reasons spec. A failure that domain logic acts on is a state with a transition; one that only the sender needs is a result.
- **Events on `window` only, with the element in `detail`.** A listener can compute `detail.element.closest(...)` and get the same scoping. Rejected: it has no `stopPropagation`, so a scope cannot keep a failure from the page toast without the two coordinating by hand, and it puts a DOM node in a detail object that the inspector serializes.
- **An `onError` option on `dispatch()` or a global `onDispatchError(fn)` registration.** Rejected: a second channel for what the result and the events already say. Module state is also per bundle (`client/use.ts`, the dual-bundle note), so a registration made in one island's bundle would not be seen by another's.
- **Throwing from `dispatch()`** so islands use `try` / `catch`. Rejected: "resolves, never throws" is documented, and refusal is not exceptional.
- **A CSS class in place of an attribute** (LiveView's `phx-error` style). Rejected for consistency: the two existing signals are attributes, and an attribute carries the `refused` / `error` distinction as its value.
- **Setting `data-stator-failed` for a bare `committed: false`.** Rejected: a stale click would flash an error. The attribute follows the status.
- **Shipping the toast island now.** Rejected: its wording, placement and timing are the app's. The recipe is thirty lines and no app has written it yet.

## Open Questions

- **Does `data-stator-failed` meet the evidence bar?** Recommended yes, on the argument above. The fallback is to ship only the bubbling events and the recipes in 3.1 and add the attribute when a starter with no islands wants failure feedback.
- **Should the attribute carry the refusal code** (a second attribute, `data-stator-refusal="full"`)? It would let a server template pre-render one message per code and let CSS choose. It is small, but it puts an app's vocabulary into an attribute. Recommended: wait.
- **When does `data-stator-failed` clear, besides the next send from the same element?** Candidates: any committed send within the same form; a timeout. Recommended: only the next send. Anything else is a policy.
- **Should the runtime resync by itself on divergence?** On a live route, a missing target or a `stator:patch-error` could rebuild the channel and take the initial sync. It is the right remedy, and it risks a loop if the page's markup is simply wrong (client code removed a server-owned node). Recommended: observable in 3.1, automatic only after the time-travel devtool work has looked at the same edge cases.
- **A 4xx or 5xx on `/__events` during a deploy.** Retrying 502, 503 and 504 under the same `eventId` is safe and would hide most restarts. It belongs to the connection-lifecycle design; listed here so it is not lost.
- **`from` on island `dispatch()`**, so a failure in an island bubbles from its element to an enclosing scope. No use yet: the island has the result.
- **Should a 422 on an enhanced form submit set `data-stator-failed="refused"`?** It cannot tell a refusal from any other 422 without an envelope convention for API routes, which the reasons spec leaves open. Recommended: `error` for every non-2xx enhanced submit until that is decided.

## Implementation Notes

Three small PRs for 3.1, after [[refused-dispatch-reasons]] PR 1 (the transport) and PR 4 (`stator:dispatch-refused`). The first can go in with PR 1.

**PR A — hardening (S).** `wire/apply.ts`: the per-patch `try`, `stator:patch-error`. `client/transport.ts`, `client/runtime.ts`, `client/dispatch.ts`: `stator:event-sent` and `stator:patches-received` fired from the shared path so island dispatches have them (the page runtime's `durationMs` and `source` stay as they are). `client/inspector.ts`: a row for `stator:patch-error`. Tests: `tests/client-runtime.test.ts` (a batch whose second patch throws applies the third and the directives, and fires one `stator:patch-error`), `tests/client-dispatch.test.ts` (an island dispatch fires `stator:event-sent`; a malformed 200 resolves). Docs: `reference/client.md` window-events paragraph. Changeset: minor (one new event).

**PR B — events from the element, and `data-stator-failed` (S).** `client/transport.ts`: `emitFrom`, used by both emitters; `postEvent` takes the element as an optional argument. `client/runtime.ts`: pass `el` or the form; `beginPending` removes `data-stator-failed`; the refusal and failure paths set it; `submitForm` does the same. Tests in `tests/runtime-dispatch.test.ts`: a listener on an ancestor receives the event and `window` receives it too; `stopPropagation` on the ancestor keeps it from `window`; an element removed mid-flight still produces the event on `window`; `event.detail` is unchanged from PR 4; the attribute is `refused` after a 422, `error` after a 403 and after exhausted retries, absent after a bare `committed: false`, and removed when the element sends again; island `dispatch()` still fires on `window` and sets no attribute. Docs: `reference/client.md` (the attribute beside `data-stator-pending`; that the events bubble). Changeset: minor.

If the attribute is declined, PR B is `emitFrom` and its four tests.

**PR C — docs (M).** A guide section "When an event doesn't go through" in `guides/dispatching-events.md` (or its own page under Guides): the result table from the reasons spec, the island branch, the attribute with the `:has()` sample, the toast recipe, the scope recipe, and a paragraph on what none of them catch (divergence, island faults, connection state). `tutorial/05-handling-events.md`: its failure paragraph gains the attribute. Style `data-stator-failed` in the four examples that style `data-stator-pending` (`apps/store`, `desksmith`, `live-poll`, `weather`), in the post-release example sweep. `examples/registration`: `UNSENT` reads `error.phase`.

Nothing here changes the engine, the server or the wire.

ROADMAP entries to add when this is accepted: under Primitives, "Scoped event error handling (evidence-gated)" with the triggers from the staging table; under the connection-lifecycle item, rows 13 to 16 of the failure table.

## Decision record (2026-11-22, Tony)

- **In 3.1:** the hardening (`dispatch()` never rejects; a per-patch `try` with `stator:patch-error`; the replay cache keeps the status; a 422 on `/__events` logs at `debug`; a refusal is detected by its body), and failure events fired from the sending element with `bubbles: true`.
- **Parked, waiting for evidence:** the `data-stator-failed` attribute. Trigger: an example with no islands wanting failure feedback.
- Connection state, session expiry and a route-level error page remain separate designs.
