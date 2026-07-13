# Primitive gaps — the thought experiment (2026-07-13, with Tony)

> Working analysis. The commitments promoted from here live in the public
> [ROADMAP.md](../../ROADMAP.md); items graduate when an example or real
> app provides the evidence. This file keeps the full ranked list, the
> evidence, and the speculative tail.

What real apps need that has no home in the framework today. Ranked by
confidence, with the in-repo evidence that exposed each. The tell for a
missing PRIMITIVE (vs a missing recipe): we "solved" it by stepping outside
the framework entirely.

## Near-certain (our own repo worked around them)

1. **Async data loaders.** Frontmatter/render is synchronous (permanent
   contract) → `await db.query()` / `await fetch()` on a page has NO home.
   Evidence: the machines-native demo dodged databases entirely; the planned
   "working with a database" guide runs straight into it. Design questions:
   loader runs pre-render (sync diff preserved); live-page semantics (does
   fan-out re-run it? per-connection cache? loader-as-pseudo-machine with
   touch semantics?). Needs a design note BEFORE it's asked publicly.
2. **Snapshot migration/versioning.** Old persisted snapshots hydrate into
   new machine shapes = undefined behavior. Evidence: we FLUSHED REDIS at
   the Desksmith→Plimsoll cutover (same-named CartMachine, incompatible
   shape). Shape: `version` on defs + `migrate(old)` hook; log-loud fresh
   fallback exists for app machines already.
3. **Scheduled time.** No statechart `after` (per-state timeout events) and
   no durable recurring schedules. Evidence: the tide reset is a bare
   setInterval in apps/store/start.ts, outside every abstraction. Two
   primitives: host-scheduled state timeouts (cheap), durable schedules
   (pairs with durable effects).

## Likely (the scoped examples will prove them)

4. **User lifecycle** — session+app exist, user doesn't; userId-keyed
   app-machine slices are the pattern; primitive needs an identity resolver
   + a third fan-out scoping rule (user-touches → that user's connections
   across devices). `with-auth` example will pressure-test.
5. **Route middleware/guards** — section-wide gating (/admin/**) vs
   copy-pasted per-page when(); natural home for session rotation on
   privilege change.
6. **Presence + connection lifecycle** — no join/leave into machines, no
   per-key "who's here". planning-poker will make the case (multi-tab ≠
   people; refresh debounce).

## Worth the thought, lower urgency

7. **Effect cancellation** — stale completions are guard-dropped but
   in-flight WORK isn't aborted; AbortSignal in effect meta on state exit.
8. **Transient context keys** — everything in context persists +
   structuredClones; a `transient` marker covers secrets, caches, and
   softens the big-context perf cliff.
9. **Rate limiting** — maybe a recipe over middleware (#5), not a primitive.
10. Known 1.x set (unchanged): Redis backplane, durable effects/outbox,
    waitFor sagas, dispatch-returns-snapshot, lazy machine refs,
    stator check CLI.

## Examples/docs plan feeding this (2026-07-13)

- Example starters: `with-auth` (+auth guide: identity-is-addressing,
  guards-as-authz, identity-from-context-never-payload), `planning-poker`.
- Recipes section in docs: auth, webhooks, file uploads, where-data-lives.
- Build order: with-auth + guide → database guide → webhook/upload recipes
  → planning-poker.
