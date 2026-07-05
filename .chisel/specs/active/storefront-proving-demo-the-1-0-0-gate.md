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

## Imagery (decided 2026-07-04)

No photography. Products are hand-drawn SVG **catalog plates** — flat
side-profile line art with region fills (upper/sole/accent) as CSS variables:
one drawing per product covers every colorway; the variant island recolors
the plate live; zero licensing exposure; tiny payloads; fits the chandlery
register. Style proven with a rendered 4-colorway Longshore (3 iterations,
sharp render-and-check loop). ~13 plates total, drawn during build steps 1–2.
Fallback: catalog schema references images by key, so AI-generated photos can
replace plates later without data changes. Content sheet (brand, catalog,
proof render): artifact "content-draft-02-imagery".

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

## Mid-build decisions (2026-07-05, with Tony)

1. **Doctrine: forms for values, events for intents.** Server-template `on:`
   payloads are static by design (render-time serialization); inputs send
   data the way the platform intends — forms. Cart rows use +/− steppers
   (static payloads); checkout fields POST to API routes. No event-value
   mechanism for 1.0 unless the log ends up showing compelling pressure.
   Aligns with the browser-spec-first instinct; document as doctrine when the
   demo ships.
2. **Product-page stock badges:** server renders EVERY variant's badge (SSE
   keeps them fresh); the island only toggles which is visible. Client owns
   "which variant am I looking at," server owns "what's in stock."
3. **Public-deploy hygiene:** checkout PII fields prefilled with fake data
   (disable if it still feels risky); admin order feed shows id/items/total/
   time only. Session TTL verified NOT a gap: RedisStore slides a per-session
   TTL on every persist (default 24h, `sessionTtlSeconds`); public deploy
   uses ~2h. Nightly reset cron restores seed stock + clears orders.
4. **Admin surface:** built and validated for the launch gate (it's the
   gateway-pattern + cross-session-SSE evidence), but the public deploy gates
   it behind an env flag (off by default in prod). Fallback if that feels
   wrong later: drop it from the demo entirely and keep it as a documented
   feature.
5. **Casts:** `catalog.all as Product[]` was unnecessary — selector inference
   through InstanceOf works; removed. `params.x as T` is necessary and
   acceptable (params are Record<string,string>); 1.x idea: sync-generated
   typed `Stator.request` per route from the filename.

## Analysis: ApiRouteHelpers read/`snapshot` (2026-07-05, deferred)

Considered with Tony after step 4. The boundary: dispatch-only makes API
routes WRITE-ONLY; commands don't need reads, responses do. Pattern families
where a read is genuinely necessary and merging machines is wrong:

1. **Non-HTML representations** — JSON endpoints, feeds, exports, webhook
   status responses. Nothing to merge; the route just can't see the state it
   must serialize. Any headless surface hits this on day one.
2. **Create-then-redirect-to-id** — needs post-dispatch state. Shipped
   evidence: poll `new.ts` navigates to `/` instead of the created poll.
3. **Cross-lifecycle** — session handler consulting app state (reserve-on-add
   stock checks). Merging is structurally impossible.
4. **Cross-cutting session machines** — auth/quota/flags gating synchronous
   handler work (presigned URLs, 403s). Merging duplicates identity.

NOT needed for: form→dispatch→navigate, machine-owned side effects
(effects), machine reactions (emits), UI (page reads).

Disposition: not for the demo; not 1.0-blocking IF docs state "API routes
are command endpoints in 1.0"; top of the 1.x list.

**Concurrency addendum (2026-07-05, with Tony):** the general primitive (live
read anywhere in an async handler) must NEVER be built — structural hazards,
not implementation details: (a) handlers hold the session lock for their full
duration, so poll-snapshot-until-effect-settles is a guaranteed DEADLOCK
(completions re-enter via the same lock); (b) app machines have no session
lock → snapshot is TOCTOU by construction, authoritative checks stay guards;
(c) torn reads across subscription-linked machines when snapshots straddle a
dispatch. Pages avoid all three via the sync render contract (reads+render =
one synchronous section under the lock) which cannot reach async handlers —
the original reason this was skipped, confirmed. Safe narrow shapes if 1.x
wants them: (1) `dispatch()` RETURNS the touched machine's post-commit
snapshot (read atomic with commit — solves create-then-redirect exactly);
(2) frozen-at-entry snapshot for pure readers (JSON endpoints), taken
synchronously under the lock, documented point-in-time.

**Separate 1.0 robustness finding — FIXED 2026-07-05, three layers:** emit
cascades had no cycle protection. Now: (1) runtime depth cap (32 hops) with a
diagnosable emit trail; (2) wire-time graph DFS warning for resolvable
cycles; (3) undefined-`from` diagnosis. Layer 3 exists because Tony's Vite
instinct proved right and the original TDZ claim wrong: cross-file
subscription cycles do NOT crash at import — Vite SSR and tsx interop both
resolve the mid-cycle binding to `undefined` SILENTLY (verified empirically
with a two-file probe), so the graph warning can't even see the edge. The
store now converts that into a named circular-import error at construction.
Also agreed: cycle feedback stays boot-time (a) — plus a 1.x `stator check`
CLI (b) running store-construction validations for CI. `waitFor`-in-effects
noted as a 1.x coordination primitive (needs timeout/deadline design; await
cycles hang silently — not a substitute for the cascade cap).

## Friction log

(Running record of every paper cut, workaround, or API wish encountered —
reviewed before cutting 1.0.0.)

- **Step 0 (2026-07-04):** in-monorepo scaffold needs a manual dep flip to
  `workspace:*` (expected; only affects us, not consumers).
- **Step 0:** create-stator's `stator-env.d.ts` lacked the `biome-ignore` for
  its `props?: any` fallback — consumers with strict Biome configs would fail
  lint on a file we shipped. FIXED in the template.
- **Step 1:** none — catalog machine, faceted browse, and pagination went
  through on first inference; the `when(!!cat, () => ...)` guard pattern for
  invalid params remains the sanctioned 404 idiom (no first-class 404 API,
  fine for 1.0).
- **Step 2:** island templates are compiled once per component, so
  variable-length UI (a per-product swatch row) can't be expressed in the
  template — the picker builds its option buttons imperatively on connect.
  Fine as "islands are custom elements; use the platform," but a client-side
  `each()` over attrs is a legitimate 1.x candidate if this recurs.
- **Step 2 (testing lesson, not a bug):** Vite's dev middleware compiles
  island-module URLs because browsers send `Sec-Fetch-Dest: script`; a bare
  curl sees raw source. Cried wolf on a "framework bug" for half an hour
  before reading Vite's middleware. Probes of dev-plane module URLs must send
  that header (now noted in dev.ts).
- **Step 4:** `ApiRouteHelpers` exposes only `dispatch` — a handler cannot
  READ another machine's state, so the submit route couldn't compose a
  server-authoritative amount from a separate CheckoutMachine. Resolved by
  better modeling (cart + checkout are ONE order-draft machine; the charge
  effect computes its amount from its own context), and arguably the
  limitation pushed toward the right design. Still: a read/`snapshot` helper
  is a fair 1.0-consideration for flows where merging machines isn't right.
- **Step 4 (works-as-designed):** the full effect arc verified over the wire
  — instant `submitting` commit, decline → review with error, approve →
  confirmed with receipt + cleared manifest, guards silently dropping
  empty-cart begins and bad emails. Effect return annotation (`Promise<Events
  | null>`) required exactly as documented; no surprises.
- **Step 5:** the whole app-plane story worked first try over the wire:
  cart emit (payload incl. items) → InventoryMachine (persist:true)
  decrement → low-water app effect → RESTOCK_ARRIVED refill, badges via
  nested keyed reads (slot ids compose: `s1:i0:s0:k<sku>:s0`). Refill SETS
  the level rather than adding, so racing restock chains converge without
  locks — worth documenting as an idempotent-effect pattern. One deliberate
  smell: the island reaches OUTSIDE its root to toggle badge visibility
  (`document.querySelectorAll('[data-stock-badges]')`) because islands can't
  wrap server children — same root cause as the imperative-options entry
  (step 2). If a third island needs a reach-out, that's the signal to design
  island/server-children composition for 1.x.
- **Content note (not framework):** sandal plate still reads weak; one more
  drawing pass in step 2. `/c/all` view added — no single category exceeds
  page size, so the all-goods aisle is what makes pagination real.
