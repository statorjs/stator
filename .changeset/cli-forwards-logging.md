---
"@statorjs/stator": patch
---

`stator start` and `stator dev` now forward `logging` from `stator.config.ts` to the server (previously `logging.level` was a silent no-op under the CLI — only the `LOG_LEVEL` env var worked), and `stator dev` also forwards `secret`, so signed cookies work in dev with a config-file secret instead of requiring the `STATOR_SECRET` env var.
