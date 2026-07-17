---
title: Attribute composition on an element is drop-not-merge
status: ready
created: 2026-07-17
updated: 2026-07-17
area: compiler
---

## What and Why

Two confirmed compiler/template bugs found building `examples/weather`, sharing
one root cause: **when more than one source sets attributes on the same element,
the framework drops or overwrites instead of merging.** Both are silent — valid
HTML renders, but an attribute the author clearly intended is simply gone.

### Bug A — static `class` + `class:list` on one element emits two `class` attrs

`<button class="place-tab" class:list={{ active }}>` compiles to a tag with
**two** `class` attributes (`class="active" … class="place-tab"`). The HTML
parser keeps the first and drops the rest, so the static `place-tab` silently
vanishes. (Same hazard applies to static `style` + `style:list`.)

### Bug B — a component/island's *root-element* static attributes are dropped

The root element of a component/island definition loses every static attribute
it's authored with. `templates/tile-motion.stator` root
`<tile-motion hidden title="probe" data-probe="p">` reaches the DOM as a bare
`<tile-motion>` — all three dropped. The live-sky island's root
`<live-sky class="live-sky">` reaches the DOM as `class=""`. Only **usage-site**
attributes survive (`<LiveSky scene={…} />` sets `scene` fine), so a component
cannot carry its own base class / `hidden` / ARIA / `data-*`.

These are the same gap seen twice: attribute application on an element is
"last-writer-wins / silently drop" where it should be a **merge** — `class` and
`style` concatenate; other attributes take a defined precedence (usage-site wins
over definition-root, explicit wins over directive) without dropping the loser.

## Success Criteria

- `class="a"` + `class:list={{ b: cond }}` on one element yields a single
  `class` attribute containing `a` and (when `cond`) `b`. Same for `style` +
  `style:list`.
- A component/island root's static attributes reach the DOM, merged with
  usage-site attributes (usage wins on scalar conflict; `class`/`style`
  concatenate).
- A compile-time error/warning on any *unmergeable* duplicate that would
  otherwise be silently dropped.

## Constraints

- Must not change the meaning of existing single-source attributes.
- `class`/`style` merge order must be deterministic (static first, then
  directive/usage) so cascade behaviour is predictable.

## Approach

- Collect all attribute contributors for an element at compile time (static
  attrs, `class:list`/`style:list`, and — for component roots — the usage-site
  attrs) into one map keyed by attribute name.
- `class` and `style` reduce by concatenation; scalars resolve by precedence;
  emit exactly one attribute each. For component roots, merge definition-root
  attrs under usage-site attrs.
- Where a genuine conflict can't be merged, emit a build diagnostic rather than
  dropping silently.

## Alternatives Considered

- **Document "don't combine them" and leave it.** Rejected: both patterns are
  natural (a base class + a conditional; a component that styles its own root),
  and the failure is silent. Workarounds exist (put everything in `class:list`;
  style islands via tag selectors) but they're papering over a real gap.

## Open Questions

- Precedence when a component root and usage site both set a non-`class`/`style`
  scalar (e.g. both set `title`) — usage-site wins is proposed; confirm.
- Should `id` collisions between root and usage be an error (two ids is never
  right) rather than a silent pick?

## Implementation Notes

- **Landed** on `fix/live-path-element-ids-and-reads`: Bug A — `class`+`class:list`
  (and `style`+`style:list`) on one element is now a compile-time error, per the
  decision to force everything through the `:list` rather than merge
  (`lower.ts`; `tests/class-list-collision.test.ts`). Bug B — a client
  component's own root static attributes are carried across the
  split-and-reassemble and merged under usage-site props (class/style concat)
  (`compile.ts` `staticRootAttrs` + `client-shell.ts`;
  `tests/component-root-attrs.test.ts`). Note the two halves diverged by design:
  #1 errors, #4 merges.
- Evidence + workarounds in `examples/weather/FINDINGS.md` (#1 = Bug A, #4 = Bug
  B). Weather currently: everything-in-`class:list`, islands styled by tag
  selector.
- Sibling of the live-path correctness spec
  (`conditional-arm-interiors-are-second-class-on-the-live-update-path`) — that
  one is the runtime/diff path; this one is the compiler/attribute path. Two
  different seams, both surfaced by the same example.
