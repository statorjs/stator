---
"@statorjs/stator": patch
---

A JSON import with `with { type: 'json' }` loads under `stator dev`, `stator start` and `--import @statorjs/stator/register`. The TypeScript loaders transformed every file for a `node20` target, and esbuild drops import attributes for that target, so Node refused the module with `ERR_IMPORT_ATTRIBUTE_MISSING`. The transform now targets the Node that runs it, the only runtime its output executes on.
