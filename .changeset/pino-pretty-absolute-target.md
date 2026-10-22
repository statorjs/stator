---
"@statorjs/stator": patch
---

The dev logger now hands pino the resolved absolute path of `pino-pretty` instead of the bare package name. pino 10.4 resolves a bare transport name from its callers' script names, which a module evaluated through a Vite SSR runner (vitest, and any app whose test setup inlines `@statorjs/stator/server`) doesn't have, so the server module failed to load with `unable to determine transport target for "pino-pretty"`. An absolute path is passed through untouched.
