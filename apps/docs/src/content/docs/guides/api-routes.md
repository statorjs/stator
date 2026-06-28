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

Export by method (`GET`, `POST`, …).

## The request

`request` carries `params`, `query`, `headers`, the raw `Request`, and body helpers `formData()` / `json()` / `text()`.

## Mutate with dispatch

`dispatch(Machine, event)` is typed against the machine's event union. The target must be in the route's loaded `reads` graph.

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
