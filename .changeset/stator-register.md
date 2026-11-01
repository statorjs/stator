---
'@statorjs/stator': minor
---

`@statorjs/stator/register`, and `stator test` uses it.

Stator ships TypeScript source and loads it with its own loader, and a package built on Stator ships JS that imports that source. Any process the `stator` CLI didn't start (a test runner, a script) handed such a package to Node, and Node won't strip types inside `node_modules`. So tests importing an installed Stator-based package failed to load.

- **`@statorjs/stator/register`:** registers Stator's loader in any process: `NODE_OPTIONS="--import @statorjs/stator/register" npx vitest`, `node --import @statorjs/stator/register script.ts`. The `stator` bin now uses it too.
- **`stator test`:** adds it to `NODE_OPTIONS` for the runner, keeping existing options. Stator-based packages load however deep they sit, with no detection and no Vitest config.
- **The in-process Vite dev server** (`STATOR_VITE_DEV=1`, transitional): `ssr.noExternal` also covers the app's direct Stator-based dependencies, so they share the app's Stator instance instead of loading a second one.
