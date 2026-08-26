---
"@statorjs/stator": patch
---

The island-bundling seam gains its second implementation: `STATOR_ISLAND_BUNDLER=esbuild` bundles islands through esbuild with code splitting instead of Vite. Experimental and off by default — the Vite implementation remains the default and nothing changes without the variable set. On the framework's own multi-island example the esbuild output dedupes the client runtime into one shared chunk and comes out smaller than the Vite output; the measurements live in the toolchain spec's Spike 1 results.
