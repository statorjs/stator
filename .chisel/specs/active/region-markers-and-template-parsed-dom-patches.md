---
title: Region markers and template-parsed DOM patches
status: draft
created: 2026-08-01
updated: 2026-08-01
area: runtime
---

## What and Why

Reactive control-flow regions (`each`, `when`, `match`, `defer`) each wrap their
body in a wrapper span:

```
<span data-slot="s0" data-list="true" style="display:contents">…</span>
```

(`each.ts:144`, `conditional.ts:109/165`, `defer.ts:37`). Two problems, one a hard
correctness bug and one a structural violation of a principle we should adopt.

**1. Tables (and other restricted parents) are broken.** A `<span>` is not valid
content inside `<table>/<thead>/<tbody>/<tr>/<select>/<ul>/<dl>`. The HTML parser
**hoists it out**, so a reactive `each` of `<tr>`s — a filterable table, the most
natural admin/dashboard shape — does not render correctly at all. This is not
cosmetic; it is silent-wrong-output on ordinary markup, which is the
Runtime-correctness bar.

**2. We should not mutate the DOM structure users author.** `display:contents`
hides the wrapper from *layout* but not from the *CSS selector graph*: an injected
span between real siblings breaks `.parent > .child`, `.a + .b`, `:first-child`,
`:nth-child(n)`. So even where a span is legal, we are silently changing which
selectors match. The principle: **the framework must not own, inject into, or
mis-parse the user's DOM.** Addressing must be a boundary with no box.

**3. HTML materialization mis-parses table fragments.** Separately, the `html`
patch op does `element.innerHTML = value` (`apply.ts:40`) with no `<template>`.
Setting `.innerHTML` on a non-table element drops table-context children
(`<tr>`, `<td>`, `<col>`, `<option>`) — the same parser rule. The `insert` op
already uses a `<template>` (`apply.ts:48`) and is correct; the `html` op is a
latent copy of the table bug. `<template>.innerHTML` parses under the "in
template" insertion mode, which routes table children to the right sub-modes and
preserves them — the standard fix.

These interlock: once the wrapper span is gone (part 1/2), the `html` op has no
element to set `innerHTML` on — it *must* become "template-parse the fragment,
replace the range between two markers," so part 3 stops being optional and becomes
structurally required by the marker design. Verified in a probe: a real browser
drops `<tr>` from `div.innerHTML` but preserves it from `template.innerHTML`.

## Success Criteria

- A reactive `each` of `<tr>` inside a real `<tbody>` renders correctly and
  supports insert/remove/move (the filterable-table repro below), verified in a
  **real browser**.
- No framework-injected node changes which CSS selectors match the user's
  authored elements (no phantom sibling/child).
- `when`/`match`/`defer` regions work inside tables and other restricted parents.
- The `html` and `insert` ops agree: both materialize via `<template>`, so
  table-context fragments survive on every path.
- No change to the authoring API, to user-observable layout/behavior, or to the
  wire `Patch` type shapes. Minor release (see semver note).

## Constraints

- **Real-browser verification is mandatory and gating.** happy-dom (our test env)
  does **not** implement the parser's table insertion modes — a probe kept
  `<tr><td>x</td></tr>` inside a plain `<div>`, which a real browser strips to
  `x`. So the *entire existing suite is blind to this bug class* (which is why it
  shipped), and a happy-dom test here would pass on broken code — worse than
  useless. This work must add real-browser test infrastructure (Playwright /
  headless Chrome); there is none today (grep-confirmed: no Playwright/Puppeteer/
  e2e). That infra is a standalone win (time-travel spike, islands, focus/scroll
  all want it).
- **Text/attr bindings are out of scope.** `data-stator-id` on real elements
  (text/attr) *stamps existing nodes*, it does not inject — it is fine and stays.
  Only the four *region* wrappers move. `data-slot` on text-binding spans
  (`<td>{read()}</td>`) also stays. This bounds the change.
- Must not regress keyed reconciliation (insert/remove/move) or initial-sync,
  which address rows positionally.

## Approach

Three interlocking parts.

**A. Region boundaries → comment markers.** Replace the wrapper span with a pair
of HTML comments delimiting the region:

```
<!--s:s0-->…region body…<!--/s:s0-->
```

A comment is legal anywhere the parser accepts character data — including between
`<tr>`s and `<option>`s — has no box, no layout, and does not participate in the
CSS selector graph. The region is the *range between its markers*, not an element.

**B. HTML materialization → always `<template>`.** Unify the `html` op with the
`insert` op: parse every patch fragment via `<template>.innerHTML`, then splice
`tpl.content`. Table-context fragments survive on all paths.

**C. Range-based apply ops.** With no wrapper element, the client resolves a
region to its marker pair and operates on the sibling range between them:
- `html` (region re-render) → remove nodes between the markers, insert the
  template-parsed fragment there.
- `insert`/`remove`/`move` (keyed list) → index within the marker range instead of
  `element.children[i]` (`apply.ts:47-57`).
- Marker lookup replaces `document.querySelector('[data-slot=…]')` for regions
  (`apply.ts:20`); a comment-node walk or an index built once at hydration.

Server emit changes at the four wrapper sites; `resolveTarget` and the op branches
in `apply.ts` change on the client; `recompute.ts` positional counting for keyed
lists must count within the range.

## Alternatives Considered

- **Keep spans, special-case tables** — e.g. emit `<tbody>`-shaped wrappers in
  table context. Fragile (must detect context in the compiler), doesn't fix the
  selector-graph pollution (#2) at all, and multiplies wrapper variants. Rejected.
- **`display:contents` is "good enough"** — false: it hides layout, not the
  selector graph, and does nothing for the parser-hoist bug. This is the status
  quo that is broken.
- **Markers only for tables, spans elsewhere** — two region-addressing schemes to
  maintain and test; the selector-graph argument applies everywhere, so do it
  once. Rejected.

## Open Questions

The spike exists to answer the load-bearing one:

- **Can comment-delimited ranges support insert/remove/move/replace as robustly as
  today's indexed `element.children`?** This is the make-or-break. Today's ops get
  a real parent element and clean integer indexing; a marker range has no parent
  and requires sibling-walking between two comment nodes. This is surgery on the
  compose/identity seam that already produced four bugs (#20) and a near-miss
  (#24) — the seam the complexity review flagged to watch. If sibling-walking
  proves robust across tables, keyed reorders, and nested control flow → clear win.
  If it is fragile → we learn cheaply and reconsider.
- Nested regions: a `when` inside an `each` row is markers-within-markers — does
  range counting compose cleanly?
- Marker resolution performance: comment-node walk per patch vs. a hydration-time
  index of marker pairs. Which, and who owns the index's lifecycle?
- Inspector: it currently highlights `data-slot` elements; with no element it must
  highlight a range. New presentation.
- Does the reference-docs mention of `SlotTarget` "for custom tooling" need a
  compatibility note (see semver)?

## Semver

**Minor.** Walking the contract surfaces:

- Authoring API (`.stator`, `defineMachine`, `read`/`each`/`when`) — identical.
- User-observable rendering (layout, computed styles, behavior) — preserved, and
  *improved* (markers don't pollute the selector graph a span does).
- Wire `Patch` type shapes (`SlotTarget`, `insert`/`remove`/`move`) — unchanged.
- Persisted snapshots — not involved (wrapper is render output, never persisted).
- Hydration across versions — server + client ship from the same package/deploy;
  no skew.

One asterisk: the reference docs describe `SlotTarget` as addressing `data-slot`
"for custom tooling." External tooling that manually resolves *region* `data-slot`s
(essentially nobody) would need updating — a doc clarification, narrowed further
because text-binding `data-slot` spans stay. `data-slot` does not disappear.

**Low semver risk is not low regression risk.** This is a high-touch rewrite of
the apply/addressing path — exactly the seam that has been the framework's most
bug-dense. Minor to *ship*, but not low-risk to *build*; hence spike-first with
real-browser verification gating.

## Verification

- **Acceptance repro:** a table with a search/filter input; typing filters rows,
  producing `remove`/`insert`/`move` patches against a real `<tbody>`. Rows must
  render (part 1), the filtered set must be correct (part C), and typing must not
  corrupt sibling order (keyed reconciliation within the range).
- **Real browser, not happy-dom** — the repro must run in Playwright/headless
  Chrome. A parallel happy-dom run is acceptable only as a fast inner-loop check
  that is *known* not to exercise the parser modes; it can never be the gate.
- Regression: existing keyed-each, when/match, defer suites still green; nested
  region (when-in-each) renders and patches correctly; `<select>`/`<option>` and
  `<ul>`/`<li>` reactive lists as secondary restricted-parent repros.
- `<template>`-materialization unit check: an `html` patch whose value is
  `<tr>…</tr>` yields a `<tr>` (not stripped) — asserted in a real browser.

## Implementation Notes

<!-- Updated during/after implementation. -->
