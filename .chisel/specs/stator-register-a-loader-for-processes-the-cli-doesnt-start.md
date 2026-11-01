---
title: "@statorjs/stator/register: the loader for processes the CLI doesn't start"
status: in-progress
created: 2026-11-01
updated: 2026-11-01
area: tooling
---

## What and Why

Stator ships TypeScript source. `stator dev`/`start`/`build` register an esbuild loader (`src/cli/loader.js`) before importing anything. A package built on Stator (a component library, a runtime package like `@indiepub/stator`) ships built JS that imports that source.

Any process the CLI doesn't start, which includes test runners, has no loader:
- **From npm:** Stator sits inside `node_modules`, where Node refuses to strip types at all (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
- **From a linked checkout:** Node's strip-only mode rejects constructor parameter properties (`session-runtime.ts:39`).

Vitest compiles `.ts` itself, but hands a dependency's built JS to Node, so the failure appears once a test imports a Stator-based package. tonysull.co's whole suite failed to load on 2026-11-01 once `@indiepub/stator` came from the registry (26 of 27 files). Production is unaffected, because `stator start` registers the loader.

## Decision

Make the loader available to any process, and have `stator test` pass it. This works at Node's level, so it's independent of Vite (a dependency Stator may drop) and needs no dependency detection.

Rejected: detecting the app's Stator-based dependencies and adding them to Vitest's `server.deps.inline` (branch `fix/stator-dependents-in-tests`, parked). It's tied to Vite settings. It misses transitive and hoisted dependencies, apps with their own Vitest config, and any runner not launched by `stator test`, each failing with the same unexplained error.

Deferred: publishing compiled JS as the default entry, with source behind a condition. It's the only zero-config fix, but a larger change: about 14 modules locate files through `import.meta.url`, non-TS files would need copying, and the bundled `.stator` components would need compiling at publish time. Revisit if the one-line `--import` proves a burden.

## Design

- **`src/register.js`** (export `./register`), plain JS so Node imports it with no loader in place. It checks for `module.register`, registers `./cli/loader.js`, and enables source maps. The `stator` bin imports it instead of registering inline.
- **`stator test`:** spawns Vitest with `NODE_OPTIONS` plus `--import <register.js as a file URL>`, keeping existing options and not adding it twice (`testEnv`). Child processes and Vitest's forks inherit it.
- **`dev-vite.ts`** (`STATOR_VITE_DEV=1`, transitional): with the loader, Stator-based packages *load*. But under the in-process Vite server they'd load through Node with a second Stator instance, and a component they render (`Picture`) finds no render context. `ssr.noExternal` therefore also covers the app's direct Stator-based dependencies. This is internal and goes away with the Vite exit; the native server and production have one module graph.
- **Docs:** the CLI reference (`stator test`) and the Testing guide ("Running the suite": the one-liner for editors, `npx vitest`, scripts and other runners, and the two error messages it answers).

## Verification

- **`tests/register.test.ts`:**
  - Builds an app with Stator *copied* into `node_modules` and a package two levels down (`@acme/widgets` → `@acme/runtime` → Stator).
  - Without the loader, Node fails (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
  - With it, the package loads, both through `stator test`'s environment and through the public specifier.
  - `testEnv` keeps existing `NODE_OPTIONS` and is idempotent.
- **tonysull.co** with `@indiepub/stator@1.0.0-beta.53` from the registry: 28 files and 196 tests pass through `stator test`, and the same through plain `NODE_OPTIONS="--import @statorjs/stator/register" npx vitest run`.

## Not covered

- A tool launched outside the CLI still needs the flag (editors, `npx vitest`, scripts). It's documented as one line.
- Under the transitional Vite dev server, a Stator-based package that isn't a direct dependency loads as a second instance.
