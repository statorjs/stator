---
title: API routes
description: "defineApiRoute, the request/response surface, and response directives."
sidebar:
  order: 7
---

An API route is a `.ts` file under `routes/` that handles non-page requests — form posts, mutations, JSON endpoints.

## Define a route

```ts
import { defineApiRoute } from '@statorjs/stator/server'
import CartMachine from '../machines/cart.ts'

export const POST = defineApiRoute({
  reads: [CartMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    await dispatch(CartMachine, { type: 'ADD_ITEM', productId: String(form.get('id')) })
    return { directives: [{ type: 'navigate', to: '/cart' }] }
  },
})
```

Export by method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`). The mutation
methods are **command** routes, as above. A `GET` export is either a page
(`defineRoute`) or a **[data route](#data-get-routes)** — `defineApiRoute`
declaring `method: 'GET'` — serving JSON, XML, or text instead of a rendered
page.

## The request

`request` carries `params`, `query`, `headers`, the raw `Request`, and body helpers `formData()` / `json()` / `text()`.

## Mutate with dispatch

`dispatch(Machine, event)` is typed against the machine's event union. The
target must be in the route's loaded `reads` graph, and it must be a
**session**-lifecycle machine — dispatching to an app machine throws at
request time. To change app state from a handler, go through a session
gateway machine's emit (see [app machines](/guides/app-machines/)); for
server-originated events with no session at all (webhooks, cron), use
`app.dispatchToApp(Machine, event)`.

## Commands don't read, queries don't dispatch

A command handler (`POST`/`PUT`/`PATCH`/`DELETE`) can **dispatch** but not
read machine state; a data GET handler can **read** but not dispatch. The
split is structural, not policy: a handler that cannot dispatch has nothing
to interleave with effect completions or other sessions' commits, which is
exactly what makes its reads safe. Command handlers that need
state-dependent *responses* (redirect-to-created-id) remain a 1.x design;
the safe shape is settled (a read atomic with the dispatch), but a general
"read anywhere in an async handler" can deadlock against effect completions
and race shared state, so it will not exist in any version. Today's idioms:
dispatch + navigate (the machine's guards decide; the page renders whichever
state is true), put the data on a page and let `read()` do its job, or serve
it from a data GET route.

## Data GET routes

`method: 'GET'` declares a read-only **data route**: the handler receives
`machines` — read proxies keyed by machine name, the same shape a page's
render context uses — and no `dispatch`.

```ts
// routes/api/collections/[name].ts  →  GET /api/collections/:name
export const GET = defineApiRoute({
  method: 'GET',
  reads: [Collections],
  handler: (request, { machines }) =>
    machines.CollectionsMachine.forConsumers(request.params.name),
})
```

Machines hydrate under the session lock — a snapshot coherent *across*
machines — and the lock is released before the handler runs. Session
machines answer with the requesting cookie's own state; app machines answer
with the shared instance.

**The response.** A plain value is JSON, always. A string takes its
`Content-Type` from the URL's extension — `routes/feed.xml.ts` serves
`/feed.xml` as `application/xml` (also `.txt`, `.ics`, `.csv`), with
`text/plain` as the fallback. A raw `Response` passes through verbatim,
`Content-Type` filled from the extension only when you set none.

**Conditional GETs are free.** Synthesized responses carry a strong `ETag`
and answer `If-None-Match` with a bodyless 304, so polling consumers stop
paying for unchanged data.

Data routes serve no HTML: no client runtime is injected, `live:` does not
exist for them, and `/__events` refuses route keys that target them.

## Return value

Return a response envelope or a raw `Response`:

```ts
return { patches?, directives? }   // framework synthesizes the response
return new Response(...)           // full control
```

### Response directives

Side effects applied after patches:

| Directive | Effect |
|---|---|
| `navigate` / `reload` | navigate or reload |
| `push-url` / `replace-url` | update history without navigating |
| `focus` / `scroll` | move focus / scroll to a target |
| `event` | dispatch a `CustomEvent` |

## Content negotiation

HTML clients get a 303 redirect from a `navigate` directive; JSON clients get the envelope. The same handler serves both.

## Concurrency

Concurrent mutations to one session are serialized by a per-session lock, so transitions never interleave.
