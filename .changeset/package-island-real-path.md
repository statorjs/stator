---
"@statorjs/stator": patch
---

An app that uses an island from a package builds again under pnpm. `stator build` and `stator dev` failed with `island "<package>/…" missing from the bundle output` for any package installed as a symlink into a store, which is how pnpm installs every package.

The walk that finds the islands a route reaches resolved a package through its `exports` map and kept the path as written, under `node_modules/<name>`. The bundler names the same file by its real path in the store, so the bundle's output was never matched back to the island. Since 3.0.0-next.4; before that the walk resolved through `require`, which returns real paths. The walk returns real paths again, and the bundler matches its entries by real path however they were given.
