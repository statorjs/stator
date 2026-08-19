---
"@statorjs/stator": patch
---

Fix: `stator start` now passes the config `secret` through to the running app. Previously the production server only picked up the signing secret from `STATOR_SECRET` in the environment — a `secret` set in `stator.config.ts` was silently dropped in production (it worked in dev via `createDevApp`). Signed cookies configured with an explicit `secret` now work under `stator start` too.
