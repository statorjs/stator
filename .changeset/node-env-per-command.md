---
"@statorjs/stator": major
---

Each `stator` command sets `NODE_ENV` when nothing else has: `production` for `build`, `build:lib` and `start`, `development` for `dev`, and `test` for `test`. `check` leaves it unset, and a value from the shell, the platform or `.env` always wins.

`stator start` without `NODE_ENV` used to run with development defaults: pretty logs at `info`, no persistence warnings, and a session cookie sent without `Secure`. It now runs as production, and when `NODE_ENV` is set to something else it says so at startup. A plain-HTTP deploy that relied on the old cookie sets `STATOR_SECURE_COOKIE=0`.
