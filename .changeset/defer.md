---
"@statorjs/stator": minor
---

Add `defer` for async data in synchronous routes. `defer(thunk, { ready, error })` marks an async region the framework resolves outside the sync render — the thunk is kicked during render, awaited in parallel with every other defer on the page (bounded by the slowest), then rendered inline. Frontmatter stays synchronous; sync/already-resolved data fills with no placeholder. The thunk never runs under the `/__events` lock.

`defer` is the one-shot, view-scoped door for async data (a machine is the reactive door). A machine read inside a defer arm is a build-time error — caught in the compiler, dev overlay, and editor — since a defer slot is static and never re-diffed. See the "Fetching data: defer vs a machine" recipe.
