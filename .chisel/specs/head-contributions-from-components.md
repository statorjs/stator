---
title: Head contributions from components
status: draft
created: 2026-09-10
updated: 2026-09-10
area: runtime
---

## What and Why

Design note exists ([`head-contributions-from-components.md`](../docs/head-contributions-from-components.md), 2026-08-28) with status "direction sketched, build evidence-gated — the promotion trigger has not fired." This spec promotes it to a build-track spec: the trigger has fired.

The gap: `<head>` is owned by the layout plus the framework's injection pipeline (`HttpConfig.headExtras`, `loadProductionHead`, both inserted at the `</head>` boundary — per-route, framework-internal). A component cannot contribute a tag to it; today's pattern is prop-threading (the layout's `title` prop). The `indie-blog-stage-a` spec hit this directly and logged it as friction rather than building it ("per-post OG/meta... done via layout props this stage"). The personal-site IndiePub-on-Stator port is the named trigger case from the design note itself: a component that owns head-worthy knowledge the route doesn't — per-post `og:image`/`og:description` on an entry-view component, RSS/JSON-feed autodiscovery `<link>`s, JSON-LD that a reusable post-card or article component wants to emit without the route re-deriving it.

Why Stator makes this cheaper than it looks in other frameworks: the permanent synchronous-frontmatter contract means the entire component tree executes synchronously during render, so every head contribution exists at end-of-sync-pass, before the first byte could flush. No generator/streaming plumbing needed (the historically hard part elsewhere) — head contributions are just another collection on the already-ambient render context, flushed at the existing `</head>` seam.

## Success Criteria

- A component (not just a route) can contribute a typed head entry (title/meta/link) via its frontmatter.
- Contributions compose deterministically regardless of how deep the contributing component sits in the tree.
- No new pipeline: contributions flush at the existing `</head>` injection boundary.
- A `read()` inside a contribution, or a contribution from a `defer` arm, is a compile error (not a silent no-op or a runtime surprise).
- Ships non-breaking: a page with zero contributions renders exactly as it does today (route-level `title` prop threading keeps working).

## Constraints

- **Typed contributions, not raw markup.** `Stator.head({ title?, meta?, link? })` (exact grammar below) rather than a `<Head>` region — analyzability is a Stator value, and the introspection manifest / agent-readable-routes work already serializes a page's `reads`; a page's head should be serializable the same way, and dedupe becomes data semantics instead of DOM heuristics.
- **Legal in both component and route frontmatter** — a deliberate departure from the `Stator.request`/`Stator.response` route-only restriction. Those are route-only because letting any component read the request is the exact laxity Stator is disciplined about avoiding. Head contribution is the opposite case: the entire point is giving components (not just routes) a way to surface information their ancestors don't have. Restricting it to routes would defeat the spec.
- **Static-only.** A machine `read()` inside a contribution is a compile error — head is outside the patch model; extending live-diffing into it would need new machinery at the compose/identity seam the complexity review guards. A live title/meta, if ever demanded, is a response directive, not head diffing.
- **No contributions from `defer` arms** (compile error, same enforcement point as the no-`read()`-in-arms rule) — an arm can resolve after the head is already on the wire under streaming, and HTML cannot accept head tags mid-body regardless.
- **Islands excluded.** Client-side head mutation (mostly `document.title`) is different machinery, out of scope here.
- Survives the designed placeholder-and-stream future for `defer`: the sync pass completes before any streaming begins, so head serializes before the first flushed byte, with the one forced rule above.

## Approach

- **Grammar:** `Stator.head({ title?, meta?, link? })` in component or route frontmatter (exact shape TBD in implementation — e.g. `meta` as an array of `{ name?, property?, content }`, `link` as an array of `{ rel, href, ... }`).
- **Collection:** contributions land on the render context's existing ambient collection array — no new channel; the same mechanism components already use to write bindings and CSS scope without being handed an explicit prop.
- **Flush:** at the existing `</head>` boundary the pipeline already owns (`HttpConfig.headExtras` / `loadProductionHead`).
- **Document order:** falls out of the synchronous tree walk (deepest-last or source-order — matches what the two-generator prototype's yield order would have given).
- **Merge semantics, as data rules, not DOM heuristics:**
  - `title` — leaf-most (last-collected) wins.
  - `meta` — deduped by `name`/`property`, leaf-most wins.
  - `link` — deduped by `rel`+`href` identity.
  - Route/layout markup remains the base; contributions layer over it deterministically.
- **Compilation context:** reuses the `kind: 'route' | 'component'` capability-matrix gate already built for [[component-composition-and-stator-routes]] — `Stator.head` is legal in both kinds (the one capability that spans the matrix), `read()`/`defer`-arm usage inside it is the new illegal case, caught by the same located-`CompileError` machinery.

## Alternatives Considered

- **Two-generator protocol** (head generator + body generator down the tree, Tony's Astro-era prototype for exactly this problem). Superseded structurally here — the sync contract guarantees what that protocol had to trust at runtime, and the ambient render context replaces the explicit channel. Recorded because it defines the property to preserve if the sync contract ever loosens: head readiness must never wait on body work.
- **Route-level declarative only** (Next metadata / Remix meta shape) — analyzable, and this is today's answer via prop-threading. Rejected as the ceiling, not the floor: it's exactly the shape that broke down for indie-blog's per-post OG meta and is the reason the evidence bar is now met.
- **Component-level imperative markup** (`<svelte:head>` / `useHead`) — convenient, but the head becomes emergent (unknowable without executing every component) and unanalyzable for the manifest. Rejected as the grammar even though the capability ships.

## Open Questions

- Exact `Stator.head()` argument shape — single call vs. multiple calls per component; array vs. object form for `meta`/`link`.
- Should JSON-LD keep rendering in the body (today's `JsonLd` component pattern, legal HTML) as a second, still-valid option, or does this spec make head the recommended home once available?
- Should `Stator.head()` calls surface in the introspection manifest (the same reasoning that motivated typed-over-markup in the first place)?
- Interaction with the future `<Image priority>` / preload-link case named in the original note — does it consume this same primitive, or want a narrower one?

## Implementation Notes

Not started. Promotion trigger: the personal-site IndiePub-on-Stator port (dogfooding thread) needs per-post OG/meta and feed-autodiscovery links from a reusable entry-view/post-card component, which is exactly the case the original design note named as the evidence bar. Supersedes the "not built this stage" deferral in `indie-blog-stage-a`.