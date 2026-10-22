---
"@statorjs/stator": patch
---

Dev logging runs `pino-pretty` in-process as the logger's destination stream instead of as a pino transport worker. pino 10.4 locates a transport by sniffing its callers' script names, which a module evaluated by a Vite SSR runner (vitest 4, `ssrLoadModule`, and any app whose test setup inlines `@statorjs/stator/server`) doesn't have, so the server module failed to load with `unable to determine transport target for "pino-pretty"`. Dev-only prettifying never needed the worker.
