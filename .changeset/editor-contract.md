---
"@statorjs/stator": minor
---

New `@statorjs/stator/editor` subpath, the editor contract: the types the language server reads from the project's own install, starting with `StatorMacros` (the `Stator.*` macros a frontmatter can use). `stator check` now types the macros from it, so it checks against the project's own release. `toVirtualCode` takes an `ambient` option choosing between the project's types and the frozen shape of earlier releases.
