---
title: 'match() looks up its own arms only'
status: ready
created: 2026-11-27
updated: 2026-11-27
area: template
---

## What and Why

`match()` finds its arm with plain property access on the author's cases object (`packages/stator/src/template/conditional.ts:144`, `cases[String(v)]`). A matched value that names an `Object.prototype` member finds that member instead of no arm. On main, with `match(v, { a })`:

| `v` | Result |
| --- | --- |
| `missing` | empty slot (intended) |
| `constructor`, `toString`, `hasOwnProperty` | throws "when()/match() renderer must return an html`...` result" |
| `__proto__` | throws "renderer is not a function" |
| `valueOf` | throws "Cannot convert undefined or null to object" |

The matched value often comes from data (a status field, a query parameter, a stored tag), so one odd value turns a page render, or a live update, into an error. This is the template-side twin of review finding 04-F13 (engine handler lookup matches prototype keys), which names this site.

## Success Criteria

- `constructor`, `toString`, `__proto__`, `valueOf` and `hasOwnProperty` as the matched value render an empty slot, exactly what a value with no arm renders, in the plain-value form and in the machine-bound form (`match(read(...), cases)`), on first render and on a live update that switches to or away from such a value.
- A cases object that declares an arm named `toString` (or any other prototype name) still renders that arm.
- A null-prototype cases object still matches.

## Constraints

- Patch release. No API change.
- `match()` has no default arm today, so "no arm" means an empty slot; this fix does not add one.
- The change stays on the lookup lines of `conditional.ts`, so it merges cleanly with the branch that changes how a branch result is branded near the top of the file.

## Approach

`renderFn` in `match()` checks `Object.hasOwn(cases, key)` before reading the arm, and returns `null` (no arm) otherwise. The machine-bound form needs no separate change: `match()` registers the same `renderFn` as the binding's `branchRenderFn`, and `server/recompute.ts:222` calls it on a live update rather than repeating the lookup.

Other sites in `src/template/` where an author-supplied object is indexed by a key, checked for the same defect:

- `when()` (`conditional.ts`): keys on truthiness, no object lookup.
- `each()` keyed lists (`each.ts`): keys go through `coerceKeys` into a `Set`, rows into a `Map`; no object indexing.
- `clientShellAttrs` (`client-shell.ts`): iterates the author's `decl` and `base` with `for…in` and indexes `props` by those author-written keys, not by data.
- `spreadAttrs` (`directives/spread.ts`): `Object.entries` on the bag (own keys only), names filtered by pattern.
- `class:list` / `style:list` (`directives/list-attr.ts`): `Object.values` / `Object.entries` (own keys only).
- `on:` (`directives/on.ts`): the event name is checked with `TEMPLATE_EVENTS.includes`, an array.
- `VOID_ELEMENTS` (`void-elements.ts`): a `Set`.
- `html.ts`, `parser.ts`, `defer.ts`, `resource.ts`, `read.ts`: index arrays by position only.

None has the defect.

## Implementation Notes

One PR, XS.

- `packages/stator/src/template/conditional.ts`: the own-property check in `match()`'s `renderFn`.
- `packages/stator/tests/match-own-keys.test.ts`: both forms, all five names, a declared `toString` arm, a null-prototype cases object.
- Changeset (patch).
