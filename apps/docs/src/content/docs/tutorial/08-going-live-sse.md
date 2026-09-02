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

## Showing the connection state

Live routes carry one more runtime-owned signal: `data-stator-connection` on `<html>`, one of `connected`, `disconnected`, `stale`, or `idle`. A zero-markup banner in `static/app.css` is all it takes to surface a dropped channel:

```css
/* Bottom edge, so it never fights a sticky header. z-index high on purpose:
   body::before is the first box in <body>, so any later sibling with an
   equal z-index would paint right over it. */
html[data-stator-connection='disconnected'] body::before,
html[data-stator-connection='stale'] body::before {
  content: 'connection lost — reconnecting…';
  position: fixed;
  inset: auto 0 0 0;
  z-index: 1000;
  padding: 6px 12px;
  text-align: center;
  font-size: 13px;
  background: var(--surface);
  color: var(--text);
  border-top: 1px solid var(--border);
}
```

Stop the dev server while the catalog is open and the banner appears. Start it again and it clears itself — the reconnected channel converges the page in place, which is the next section's story.

Note which two states the selector lists. `idle` is deliberately not one of them: a live page hands its connection back 30 seconds after you switch away from its tab, and takes it up again when you switch back. That's a courtesy to the browser's per-origin connection budget, not a fault — style it like an outage and you get a "connection lost" banner every time someone changes tabs.

## What is / isn't realtime

Be precise about what you're getting:

- **Opt-in only.** A route is static request/response until you add `// @stator live`.
- **Reconnect means resync.** If the connection drops, goes stale, or is released while the tab is hidden, the client reopens it and the server's initial sync converges the page in place — no reload, no lost island state. Individual missed frames are never replayed, because the channel carries state and the resync is what recovers it.
- **Single-replica fan-out.** The fan-out is in-process — every connection lives on the same server instance.

:::caution[Single replica]
Multi-replica fan-out (a Redis pub/sub backplane), the durable inbox (reaching sessions with no open connection, and server-originated transitions of *session* machines), and horizontal scaling are [deferred](/introduction/why-stator/#what-ships-and-whats-deferred). On a single replica, live cross-session display updates work today — and server code *can* transition [app machines](/guides/app-machines/) directly via `dispatchToApp`.
:::

## Next

Desksmith renders, reacts, persists, and broadcasts — but it still can't take money. The final chapter adds checkout with a real async call, and with it the one pattern behind all I/O in Stator: [async effects](/tutorial/09-async-effects/).
