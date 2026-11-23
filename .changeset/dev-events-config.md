---
'@statorjs/stator': patch
---

`stator dev` now applies `events` from `stator.config.ts`. `events.gate` and `events.maxBytes` were read by `stator start` only, so a dev server always enforced the gate and used the default 64 KB body cap whatever the config said.
