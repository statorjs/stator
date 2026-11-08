---
"@statorjs/stator": major
---

Vite is gone. `stator dev` has run apps natively since 2.6; now the transitional Vite dev server (`STATOR_VITE_DEV=1`), the Vite island bundler (`STATOR_ISLAND_BUNDLER`), the `@statorjs/stator/vite` plugin and the optional `vite` peer dependency are removed, and esbuild bundles client islands in dev and in `stator build` alike. `DevApp.vite` and the deprecated `createNativeDevApp` alias are removed; `createDevApp` is the native dev server.

Migrating: remove `vite` from your dev dependencies and any `STATOR_VITE_DEV` or `STATOR_ISLAND_BUNDLER` from scripts and CI. Tests that booted the dev app in-process with `STATOR_VITE_DEV=1` run without it under `stator test`. Stator never read a `vite.config.*`, so there is nothing else to move.
