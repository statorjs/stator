---
"@statorjs/stator": minor
---

`stator build:lib` makes a library's islands safe to publish. Every compiled module, from `build:lib` and from `stator build`, starts with a compiled-shape contract stamp, `/* @stator contract=1 compiler=<version> */` (`COMPILED_CONTRACT` and `readContract` on `@statorjs/stator/compiler`). In each island's client entry, a default import of a server machine is replaced in place by its `{ name }`, so the machine's code never ships and the inline source map stays valid. Each client entry is then bundled for the browser as a check, and the publish fails, naming the importer, when anything reached imports a Node built-in or a server-side Stator module. `build:lib` reports the machines a library's islands dispatch to.
