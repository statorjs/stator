---
title: Storefront proving demo (the 1.0.0 gate)
status: draft
created: 2026-07-04
updated: 2026-07-04
area: runtime
---

## What and Why

The proving demo — a deep, realistic ecommerce storefront (Allbirds-shaped) —
is the **1.0.0 gate** per the versioning decision: 1.0.0 is cut only if this
app builds top-to-bottom against the full surface with **no breaking API
changes**. Second job: the public "see it live" showcase.

Scoping rule (decided 2026-07-04): a feature earns its place by exercising
surface no app has proven yet. Desksmith/poll already proved basics; the
unproven set is keyed `each`, effects (both planes), app persistence +
`dispatchToApp`, the gateway pattern, `bind:` in keyed rows, prod islands at
scale, and `create-stator` as a real starting point.

**Decisions:** data is machine-native (app machines + `persist: true`,
RedisAppStore in prod — no DB; validates OUR persistence story); deployed
publicly (Fly + Upstash, linked from landing/docs); Core-7 scope with
reviews/categories/search explicitly out unless the core goes fast;
bootstrapped with `pnpm create stator` (dogfoods onboarding — every friction
point is a scaffolder bug report).

Working name: **Plimsoll** (a canvas shoe; also the ship load-line — fitting
for a framework obsessed with where the waterline sits). Lives at
`apps/store`. Desksmith stays as the tutorial companion; this is the real
thing.

## Success Criteria

- Built end-to-end with zero breaking changes to the 7 stable subpaths. Any
  workaround or paper cut lands in a **friction log** section here — that log
  is the 1.0 API's final review.
- All Core-7 features working in dev AND in the production build on Fly.
- A lightweight test suite using the testing guide's own patterns (machine
  tests for checkout/inventory rules, `app.fetch` tests for the wire
  contract) — the demo doubles as the guide's living example.
- Deployed and linked from the landing page and docs.

## Scope — Core 7 (each feature ↔ what it validates)

1. **Catalog browsing** — category pages, faceted filters (size/color/
   material), pagination → selector-heavy reads, `Stator.request`
   query/params, URL-driven state, `match`/`when` at scale. [M]
2. **Product page** — variant picker as a client island (attrs seed, island→
   server `dispatch` with the chosen sku), live stock badge → islands at
   scale, machine-import stubbing in prod. [M]
3. **Cart** — line items via **keyed `each`** with inline quantity inputs
   (`bind:`) → focus survives row changes; the keyed-list marquee. [M]
4. **Checkout** — guarded multi-step flow; fake payment provider
   (`lib/payments.ts`: latency, deterministic declines by token, `effectId`
   idempotency) → **session effects** end-to-end incl. failure paths. [L]
5. **Live inventory** — `orderPlaced` emit → app `InventoryMachine`
   (`persist: true`) decrements stock; low-water triggers a supplier-sim
   **app effect** (RESTOCK_PLACED with ETA); badges update over SSE. [M]
6. **Admin** — live order feed + restock button through a **gateway
   machine** (`AdminMachine`, dev-mode "become admin" toggle, honestly
   labeled — no real auth) → the documented gateway pattern, proven. [M]
7. **Production** — `buildApp` + Fly deploy with RedisStore/RedisAppStore →
   the whole prod path under real traffic. [S–M]

**Cut** (no unproven surface): accounts/real auth, real payments, email,
search. **Optional tier** (only if core is fast): threaded reviews — the one
extra that covers new surface (recursive composition).

## Machine inventory

- `CatalogMachine` (app, no persist — static seed, reset-on-deploy correct):
  products, variants, facet options; selectors byCategory/byId/filtered.
- `InventoryMachine` (app, `persist: true`): per-sku stock; subscribes to
  `orderPlaced`; low-water → restock effect; RESTOCK_PLACED/FAILED.
- `OrdersMachine` (app, `persist: true`): order log for the admin feed;
  subscribes to `orderPlaced`.
- `CartMachine` (session): items keyed by variant sku; ADD/SET_QTY/REMOVE/
  CLEAR.
- `CheckoutMachine` (session): reviewing → submitting (charge effect) →
  confirmed | reviewing+error; emits `orderPlaced` (items payload) on
  confirm.
- `AdminMachine` (session, the gateway): BECOME_ADMIN (dev toggle),
  REQUEST_RESTOCK guarded on isAdmin, emits `restockRequested`.

## Pages

`/` (featured + categories) · `/c/[category]` (facets + pagination) ·
`/p/[slug]` (variants island + live stock) · `/cart` (keyed rows) ·
`/checkout` (multi-step) · `/admin` (live, gateway controls).

## Build order (checkpoints; friction log updated at each)

0. `pnpm create stator apps/store` (dep flipped to `workspace:*`), brand CSS.
1. Catalog machines + browse pages (facets, pagination).
2. Product page + variant island (dev plane).
3. Cart with keyed rows + `bind:` quantities.
4. Checkout + payments effect (happy, declined, idempotent-retry).
5. Inventory: emits, persistence, restock app effect, live badges.
6. Admin: order feed + gateway restock.
7. Tests → prod build → Fly deploy → link from landing/docs.

## Friction log

(Running record of every paper cut, workaround, or API wish encountered —
reviewed before cutting 1.0.0.)
