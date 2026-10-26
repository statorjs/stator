---
'@statorjs/stator': minor
---

The Toolchain tier of `/server` gets its own subpath, `@statorjs/stator/server/runtime`, so the import path carries the stability tier instead of a docs footnote. Everything the reference listed under "Lower-level exports" — `SessionRuntime`, `recompute`, `renderRoute`, `buildHonoApp`, `MachineStore`, the render-context internals, discovery, the dispatch context, effect scheduling, the SSE registry, the brand guards — plus the undocumented plumbing that had accumulated beside it (`runQueryRoute`, `buildInspectPayload`, `codeHashOf`, `discoverMiddleware`, `resolveImagesConfig`, …) lives there now. Through 2.x the same symbols are still re-exported from `/server`, deprecated, so nothing that imports them today stops resolving; the re-export is removed in the next major. `activeConnectionCount` is promoted to Stable on `/server`, because an app dashboard is exactly where it's useful.
