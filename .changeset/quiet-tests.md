---
"@statorjs/stator": patch
---

`stator test` runs quiet: framework logging defaults to `LOG_LEVEL=silent` under the test command, so suites that deliberately exercise failure paths (guarded 403s, snapshot recovery) no longer narrate them over the runner's output. Exporting `LOG_LEVEL` restores any level for debugging a failing test.
