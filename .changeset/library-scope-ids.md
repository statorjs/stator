---
'@statorjs/stator': patch
---

`stator build:lib` qualifies each component's scope id with the package name, so two libraries with the same file layout (`src/palette.stator` in each) no longer compile to the same `data-s-<hash>` — before, one library's scoped rules silently applied to the other's markup. A root with no named `package.json` keeps path-relative ids and the CLI says so. Scope hashes of published libraries change on their next `build:lib`; markup and stylesheet move together, nothing persisted is affected.
