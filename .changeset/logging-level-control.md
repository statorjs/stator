---
"@statorjs/stator": minor
---

Log-level control and a quieter production default. `createApp` (the production entry) now defaults to `warn` — errors and warnings only — while the dev server stays at `info`; the per-request HTTP lines and per-connection SSE lines that used to log at `info` are now `debug`, so a production server no longer narrates every request and connection. The one-line startup notice (`stator vX · http://localhost:PORT/ · N machines · N routes`) now prints independent of the log level, so a quiet `warn` server still confirms it booted. Set the level in `stator.config.ts` via `logging.level` (`'silent' | 'error' | 'warn' | 'info' | 'debug' | …`), or override anywhere with the `LOG_LEVEL` env (precedence: `LOG_LEVEL` > `logging.level` > default).
