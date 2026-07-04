---
title: 8. Going live with SSE
description: "Opt a route into live updates and fan changes out across sessions."
sidebar:
  order: 8
---

So far every update has been a reaction to *your own* events. The last step makes a page update when state changes from *anywhere* — another tab, another visitor, a background process — using server-sent events. We'll add a tiny "stock remaining" indicator that everyone watching sees tick down in real time.

## The default is request/response

Most pages need nothing beyond what you've already built. When you POST an event, the response patches your view — that covers the overwhelming majority of interactivity, and it works with zero extra moving parts. Reach for live updates only when a page must reflect changes it didn't initiate.

## Opting into live

A route opts into live updates with a single pragma in its frontmatter. Add `// @stator live` to the catalog route:

```astro
---
// @stator live
import ProductsMachine from '../machines/products.ts'
import CartMachine from '../machines/cart.ts'
import CustomerLayout from '../templates/customer-layout.stator'
import ProductList from '../templates/product-list.stator'

const [products, cart] = Stator.reads([ProductsMachine, CartMachine])
---
<CustomerLayout cart={cart}>
  <h1>Goods for the desk and home</h1>
  <ProductList products={products} cart={cart} />
</CustomerLayout>
```

That flag tells Stator to inject a small live marker into the page; the client opens **one** `EventSource` back to the server for that route. No client code to write — the connection and patch application are handled for you.

## Cross-session fan-out

Here's the payoff. When any session triggers a change to a machine this route reads, the server recomputes the affected bindings and pushes the patches to **every** open connection watching that route — not just the session that caused the change.

Picture an `inventory` app-machine with a `remaining` count, displayed via `read(inventory, i => i.remaining)`. When one shopper checks out and decrements stock, every other shopper with the catalog open sees the number drop — in the same patch shape you've seen all along, just delivered over SSE instead of in a POST response. The render model doesn't change; only the transport does.

## What is / isn't realtime in 1.0

Be precise about what you're getting:

- **Opt-in only.** A route is static request/response until you add `// @stator live`.
- **Reconnect means reload.** If the connection drops, the client re-establishes and re-renders; there's no missed-event replay.
- **Single-replica fan-out.** The fan-out is in-process — every connection lives on the same server instance.

:::caution[1.x]
Multi-replica fan-out (a Redis pub/sub backplane), the durable inbox (reaching sessions with no open connection, and server-originated transitions of *session* machines), and horizontal scaling are deferred to [1.x](/introduction/why-stator/#the-10--1x-boundary). On a single replica, live cross-session display updates work today — and server code *can* transition [app machines](/guides/app-machines/) directly via `dispatchToApp`.
:::

## Next

Desksmith renders, reacts, persists, and broadcasts — but it still can't take
money. The final chapter adds checkout with a real async call, and with it
the one pattern behind all I/O in Stator:
[async effects](/tutorial/09-async-effects/).
