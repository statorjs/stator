---
"@statorjs/stator": minor
---

Apps can use islands that a component library ships. When a route reaches a library's compiled island, `stator dev` and `stator build` bundle it with the app's islands and add its script to that route. The build fails, listing every problem, when a reached library component was compiled for another contract or before stamps existed, when two islands define one custom element tag, or when a library island dispatches to a machine the app doesn't register. `stator check` runs the contract check, and `stator dev` logs the other two. A library importing another library's island is now followed instead of refused. `stator build` no longer rewrites a package's `.stator` specifier to `.stator.ts`.
