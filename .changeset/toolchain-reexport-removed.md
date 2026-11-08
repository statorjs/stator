---
"@statorjs/stator": major
---

`@statorjs/stator/server` no longer re-exports the Toolchain tier (`MachineStore`, `SessionRuntime`, `buildHonoApp`, `discoverMachines`, `renderRoute`, `recompute`, `fanOut` and the rest of the plumbing). Those moved to `@statorjs/stator/server/runtime` in 2.12, where the import path carries the tier; the deprecated re-export from `/server` is removed. Import them from `/server/runtime`.
