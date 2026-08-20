---
"@statorjs/stator": patch
---

Fix a dev/prod divergence: the dev server no longer reads a user `vite.config.*`. Production (`stator build`) already ignored it (`configFile: false`), so a Vite plugin configured there would run under `stator dev` and then silently vanish from the build — an app that "worked" in dev but shipped broken. `stator dev` now sets `configFile: false` too, matching production; Stator's own plugins are unaffected (they're applied inline). Nothing in the framework, examples, or docs relied on the config being read.
