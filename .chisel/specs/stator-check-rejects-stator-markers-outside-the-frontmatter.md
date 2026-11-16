---
title: stator check rejects Stator markers outside the frontmatter
status: draft
created: 2026-11-15
updated: 2026-11-15
area: compiler
---

## What and Why

`Stator.request`, `Stator.response` and `Stator.reads` are compiled from a route's frontmatter. Written in a template's markup (even inside a prop expression, e.g. `<SubscribeForm query={Stator.request.query} />`), they pass `stator check` and then throw `ReferenceError: Stator is not defined` when the page renders. All three IndiePub themes ported on 2026-11-15 (byline, daemon, timeline) hit it independently, and the IndiePub package README's own example had it.

## Success Criteria

- `stator check` (and the compiler) reports any `Stator.*` reference outside the frontmatter as a located error: file, line, column, and the fix ("assign it to a const in the frontmatter").
- Same for templates and components, where the markers aren't available at all (the existing route-only rule), so the message says which case applies.
- `guides/templates.md` and `concepts/the-stator-file.md` say plainly where the markers can appear.

## Notes

Also reported, smaller: `stator check` warns about a script passed to `raw()` as a string literal but not about a concatenated string. Worth making consistent while in the area.
