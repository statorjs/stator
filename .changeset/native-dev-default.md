---
"@statorjs/stator": minor
---

`stator dev` now runs your app natively — the same way production runs it. The dev server no longer embeds Vite: `.stator` files compile on import in Node's module loader, your app runs from its **source tree** (so `import.meta.url`-relative paths — a SQLite file, a data dir — mean the same thing in dev as in prod), and islands bundle behind the same seam the production build uses, served from memory on the production URLs with the production `<head>` shape. The dev/prod divergence class this closes is structural: there is no second module graph for a file to load twice into, no transform that runs in dev and vanishes in prod.

The loop got faster and more precise with it. An edit re-evaluates exactly the changed modules and their importers — a `lib/db.ts` that opens a connection at top level runs once per session, not once per edit — and a failed rebuild keeps the last good build serving while the compile error (code frame included) shows in an overlay. Live reload arrives over a small SSE channel instead of Vite's HMR socket.

Fixed alongside: both dev servers recreated the default in-memory session store on every machine-touching rebuild, silently resetting **all** sessions even when no machine's code changed. The store now lives as long as the dev process, so the snapshot hydration policy does what it promises in dev: only the machines whose code actually changed start fresh, everything else carries over — cart contents and all.

Transitional surface: `STATOR_VITE_DEV=1` keeps the previous Vite-embedded dev server for one minor as an escape hatch (if something forces you onto it, please open an issue). `DevApp.vite` is deprecated — `undefined` on the native server with a one-time warning, removed in the next major. App code, config, and the CLI surface are unchanged.
