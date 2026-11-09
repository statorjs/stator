---
"@statorjs/stator": patch
---

Stator's TypeScript loader and the dev loader register through `module.registerHooks`, so `--import @statorjs/stator/register`, `stator test` and `stator dev` no longer print Node 26's `DEP0205` deprecation warning for `module.register`. The hooks run synchronously on the main thread; which files are transformed, the `.stator` compile and the inline source maps are unchanged. The CLI and `@statorjs/stator/register` now check for `module.registerHooks` (Node 22.15+ or 23.5+), within the `>=24` floor.
