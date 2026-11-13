# Desksmith

A small storefront: a catalog, a cart, a two-step checkout and an admin view. The [tutorial](https://docs.statorjs.dev/tutorial/01-setup/) builds its catalog, cart, checkout and theme toggle; this version goes further, with the admin view, cart emits, a quantity cap and `serverOnly` events.

```sh
pnpm install
pnpm dev        # dev server with live reload + the wire inspector
pnpm check      # compile every .stator file and typecheck the app
pnpm test       # the cart's and checkout's rules, plus what the wire accepts
pnpm build      # production build into dist/
pnpm start      # serve the production build
```

## What to look at

- `machines/products.ts` is an **app** machine: one catalog, the same for every visitor.
- `machines/cart.ts` is a **session** machine: each visitor's own cart, kept on the server, so it survives a reload.
- `machines/checkout.ts` has real states (`shipping`, `payment`, `placing`, `complete`) and an **effect**: the card charge in `lib/payments.ts` runs after the transition commits and reports back with an event. Those completion events are listed `serverOnly`, so a browser can't send them; `tests/wire.test.ts` shows the 403. `SET_FIELD` checks that the field belongs to the current step, because the event arrives as JSON from the browser.
- `machines/admin.ts` is an app machine fed by the cart's **emits**, and `routes/admin.stator` is a **live** page: it updates over SSE as carts change in other sessions. Open it in a second window while you shop in the first.
- `templates/theme-toggle.stator` is the one **client island**: a theme switch whose state belongs in the browser.

Try it: add items, check out with card `4242`, and watch the events and patches in the inspector at the bottom of the page. A card ending `0000` is declined.

Carts and checkouts are in memory by default. Copy `.env.example` to `.env.local` and set `REDIS_URL` to keep them across restarts.

## Learn more

- Docs: https://docs.statorjs.dev
- Reference app: https://demo.statorjs.dev ([source](https://github.com/statorjs/stator/tree/main/apps/store))
