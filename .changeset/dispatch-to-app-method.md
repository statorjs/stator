---
"@statorjs/stator": minor
---

`dispatchToApp(machine, event)` is now a method on both `StatorApp` and `DevApp` — the server-originated dispatch plane (webhooks, cron) no longer requires a `store` the dev server never exposed. The dev method follows the current store across rebuilds and runs through the Vite-loaded runtime, so SSE fan-out reaches live connections instead of a second module instance's empty registry. Also in this release: a route file exporting an HTTP-method name with the wrong constructor now errors at discovery instead of being silently skipped as a utility file, and a raw `Response` returned from an API route handler is recognized by shape (not only `instanceof`), with a warning when a return value is neither a `Response` nor a `{patches, directives}` envelope.
