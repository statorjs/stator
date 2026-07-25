---
title: Guestbook starter and the plain-language front door
status: draft
created: 2026-07-24
updated: 2026-07-24
area: docs
---

## What and Why

A Bluesky exchange (2026-07, first contact with a junior dev) exposed an
audience seam: every piece of our pitch framed against other frameworks
("fine-grained reactivity", "client state", "unit of composition") went over
their head — while two plain ideas landed instantly: **"only patch the bit
that changed"** and **"I save data to a database and want to render HTML
there too."** Developers without framework scars can't value the cure for a
disease they've never had. But they have a disease they know by name: the
page not matching the database, and too many moving parts to know which one
broke.

Two artifacts open that door:

1. **A plain-language front-door docs page** — Stator explained with zero
   framework vocabulary, anchored on "your page matches your database" and
   "fewer places for it to break". A *second* door beside the
   architecture-register pages, not a replacement.
2. **A guestbook starter** — the smallest app a beginner actually builds
   with a database (name + message, shared list, live). The
   compare-and-contrast vehicle: the same app fetch+JSON style vs Stator,
   scored in *concepts you must hold* and *things that can break*, not lines
   of code. The two-window demo (sign in one, watch the other) is the moment
   a beginner can feel without understanding SSE.

## Success Criteria

- The docs page is readable start-to-finish by someone who has never used a
  frontend framework: no term appears without a plain gloss in the same
  breath ("Stator calls this a machine" style).
- Guestbook: cross-session shared entries, live over SSE, keyed rows with
  `read(item, …)` — honest showcase of the current surface.
- The comparison counts concepts/failure-points honestly (the fetch+JSON
  version is written fairly, not as a strawman).
- The example pressure-tests the emit-relay (app machines are emit-driven
  from sessions — 1.0 limitation); findings feed the active
  client-to-app-dispatch-gateway spec per the examples-prove-primitives
  doctrine.

## Constraints

- Copy voice rules apply (no semicolons, honest maturity seam, no
  overclaiming, no self-history).
- The architecture-register pages (what-is-stator, landing §1) stay — the
  audiences coexist; each door links to the other.
- Landing page changes are proposals for Tony's sign-off, not unilateral
  edits (hero line is brand).
- Snippets on the plain page must be honest, runnable Stator code — no
  pseudo-code that wouldn't work.

## Approach

- `apps/docs/.../introduction/the-simple-version.md` at sidebar order 2
  (bump why-stator and later pages by one).
- `examples/guestbook`: app-lifecycle machine (`persist: true`) holding
  entries, session machine relaying SIGN via emit (the live-poll pattern,
  reduced to its minimum), one live route, keyed each with item reads.
- Comparison lives on the docs page (short) with the starter as the working
  proof, not a separate maintained fetch+JSON codebase.
- Short-form (Bluesky-register) version of the plain pitch as a second
  canonical pitch alongside the technical one.

## Alternatives Considered

- **Rewrite the main pitch in the plain register.** Rejected: the
  framework-literate audience is the primary adopter pool today, and the
  comparative framing is what wins them. Two doors beat one compromise door.
- **Todo list as the vehicle.** Rejected: framework-demo-coded (and we ship
  todomvc already). A guestbook is "my first real thing with a database."
- **A maintained side-by-side fetch+JSON twin app.** Rejected for now:
  maintenance cost; prose comparison + one working starter carries the point.

## Open Questions

- Does guestbook join the create-stator template menu at launch, or after it
  survives its findings pass?
- Does the plain framing earn a line on the landing page hero/lede, and in
  what form? (Tony's call — proposals in flight.)

## Implementation Notes

**Docs page + landing lead-in shipped** (#32 + follow-ups). Prototype artifact
(ink-on-paper look, wire-visibility toggle) drove the design.

**`examples/guestbook` built** (branch example/guestbook). Decisions vs plan:

- **Zero custom JavaScript** — signing is a native form POST to the same-URL
  API route (`routes/index.ts`, the todomvc/live-poll pattern), not an
  on:submit island. Chose the stronger compare-and-contrast headline and the
  period-authentic feel over no-reload submits; the signer's own page reloads
  via 303, every other open page updates by SSE patch. This also answered the
  no-JS open question: yes, by construction.
- **Rules live in `lib/rules.ts`**, applied by BOTH machines (visitor before
  emit, book before record) — the API handler is "the doorman, not the law"
  and bounces bad input with `?error=` for friendly banners.
- **Rows are static captures** (`{entry.name}`) in a keyed each — entries are
  immutable after signing, so item reads would be dishonest surface. Insert
  patches carry new signatures; the count is the second live read.
- **Absolute timestamps** (server TZ) — a static "just now" that never ages
  would be the staleness lie the item-bindings work exists to prevent.
- Visitor counter: dropped (one cute thing too many). "Thanks for signing"
  note via a session-machine read inside a when() arm (machine reads in arms:
  legal).
- Port 3002 (3000 minimal/todomvc/desksmith, 3001 live-poll, 3005 weather).

**Verified**: 5 machine tests (trim/newest-first, reject empty + >280, cap
100, visitor counts only valid); compiles through the real build (1
component); end-to-end smoke on the prod server — GET count 0 → browser-shaped
form POST 303 → entry rendered, count 1; invalid POST 303 `/?error=name` →
banner renders. Cross-window SSE remains for browser verification.