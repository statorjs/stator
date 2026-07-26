---
"@statorjs/stator": minor
---

Template internals are typecheckable in CI. `syncTypes` now also emits each template's virtual TSX under `.stator/check/` — add it to a project's tsconfig `rootDirs`/`include` and plain `tsc --noEmit` catches frontmatter and prop errors that previously surfaced only as runtime ReferenceErrors. Client-island d.ts props now derive from `static attrs` and accept live `read()` bindings, matching what the runtime always supported.
