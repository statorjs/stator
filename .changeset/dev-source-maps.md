---
"@statorjs/stator": patch
---

Stack traces and island debugging now resolve to source. The `stator` CLI opts the process into Node's sourcemap application (the runtime equivalent of `--enable-source-maps`) — the inline maps the loader pipeline already emitted now actually reach server stack traces, in `stator dev` and `stator start` alike. TS frames resolve exactly; a `.stator` frame resolves to the compiled server module (right file, generated lines). And the dev server bundles islands with inline sourcemaps, so browser devtools show your island source instead of bundled output — production bundles still ship unmapped (`sourcemap` is a dev-only option on the `bundleIslands` seam).
