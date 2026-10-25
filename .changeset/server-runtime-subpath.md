---
'@statorjs/stator': minor
---

The Toolchain tier of `/server` moves to its own subpath, `@statorjs/stator/server/runtime`, so the import path carries the stability tier instead of a docs footnote. Everything the reference listed under "Lower-level exports" — `SessionRuntime`, `recompute`, `renderRoute`, `buildHonoApp`, `MachineStore`, the render-context internals, discovery, the dispatch context, effect scheduling, the SSE registry, the brand guards — plus the undocumented plumbing that had accumulated beside it (`runQueryRoute`, `buildInspectPayload`, `codeHashOf`, `discoverMiddleware`, `resolveImagesConfig`, …) imports from there now and is gone from `/server`. That tier was never covered by semver, the `/server` barrel has carried a notice reserving this move, and no app in or outside this repo imported any of it. One promotion: `activeConnectionCount` stays on `/server` as Stable, because an app dashboard is exactly where it's useful.
