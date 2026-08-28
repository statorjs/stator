# `<head>` contributions from components

Design note, 2026-08-28 (session discussion; not scheduled work). The seam question is recorded in the Stage A spec; this is the fuller design. Status: **direction sketched, build evidence-gated** — the promotion trigger has not fired.

## The problem

The head is owned by the layout plus the framework's injection pipeline (`HttpConfig.headExtras`, `loadProductionHead`, both inserted at the `</head>` boundary — per-route, framework-internal). A component cannot contribute a tag to it; the pattern is prop-threading (the layout's `title` prop). This is the head-shaped instance of the inversion-of-control wall the ambient-by-def-reads spec records for machine state: a component owning knowledge that must surface somewhere only its ancestors control. Head contribution is the *write-up* dual of ambient reads' *read-down* — if both ship, they share the typed-requirement-channel idea and must be designed aware of each other.

## Why Stator makes this unusually easy: the sync contract does the hard part

The historically hard part of component head injection is *timing*: in frameworks with async components, a deep component can await data and then contribute head, so the head either buffers the whole page or flushes early and drops late contributions. Tony prototyped a solution to exactly this at Astro: **the framework passes two generators down the tree — one for head, one for body** — and as long as async work doesn't block the head generator, head can complete almost immediately. It worked in small tests; the discipline it demands is "components cooperate by never blocking the head channel."

Stator's permanent synchronous-frontmatter contract turns that protocol discipline into a **structural guarantee**: the entire component tree executes synchronously during render, so every head contribution exists at end-of-sync-pass — before the first byte could flush. The generator plumbing also collapses: Stator's render context is already ambient (components write bindings and CSS scope into it without being handed a channel), so head contributions are a collection array on the render context, flushed at the existing `</head>` seam. Document order falls out of the sync tree walk, which is what generator yields provided.

This survives the designed placeholder-and-stream future for `defer`: the sync pass completes before any streaming begins, so head serializes before the first flushed byte — with exactly one forced rule, below.

## The shape (if/when built)

- **Typed contributions, not raw markup**: `Stator.head({ title?, meta?, link? })` in component frontmatter (exact grammar TBD). Typed objects over a `<Head>` markup region because analyzability is a Stator value — the introspection manifest and agent-readable routes can serialize a page's head the way they serialize its reads, and dedupe becomes data semantics instead of DOM heuristics.
- **Collected in the render context**, flushed at the `</head>` boundary the pipeline already owns. No new pipeline.
- **Static-only (the defer doctrine, third instance)**: a machine `read()` inside a contribution is a compile error — head is outside the patch model, and extending patching into it means new machinery at the compose/identity seam the complexity review guards. A live title/meta, if ever demanded, is a *response directive*, not head diffing.
- **No contributions from defer arms** (compile error, same enforcement point as the no-`read()`-in-arms rule): an arm resolves after the head is on the wire under streaming, and HTML cannot accept head tags mid-body anyway.
- **Merge semantics stated as data rules**: `title` — leaf-most (last-collected) wins; `meta` deduped by `name`/`property`, leaf-most wins; `link` deduped by `rel`+`href` identity. Route/layout markup remains the base; contributions layer over it deterministically.
- **Islands excluded**: client-side head mutation is different machinery (and mostly `document.title`); out of scope.

## Alternatives considered

- **Two-generator protocol (Tony's Astro-era prototype)**: the right shape for a framework with async components; superseded here structurally — the sync contract guarantees what the protocol had to trust, and the ambient render context replaces the explicit channel. Recorded because it defines the property to preserve if the sync contract ever loosens: head readiness must never wait on body work.
- **Route-level declarative only (Next metadata / Remix meta)**: analyzable, and honestly sufficient for most server-canonical cases — the route usually knows the page's identity (per-post OG meta belongs to the route that loaded the post). This is today's answer and the reason the evidence bar is unmet.
- **Component-level imperative markup (`<svelte:head>` / `useHead`)**: convenient, but the head becomes emergent — unknowable without executing every component — and unanalyzable for the manifest. Rejected as the grammar even if the capability ships.

## Evidence status and promotion trigger

Every case hit so far has a livable route-level answer: the layout `title` prop is one level of threading; per-post OG meta is route-owned knowledge (Stage A does it via props, friction logged); `<Image priority>` needs `fetchpriority`, not a preload link; JSON-LD legally renders in body (the store's `JsonLd` component proves it). **The trigger is a reusable component that owns head-worthy knowledge the route doesn't** — a `<VideoEmbed>` wanting `og:video`, a code-block component wanting its stylesheet once per page. Likeliest first sighting: Stage B's editor or the IndiePub-port component library. Until then this note is the standing answer, not a work item.
