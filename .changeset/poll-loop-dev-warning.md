---
"@statorjs/stator": patch
---

The dev server warns when a session machine self-reschedules through `after` with a data-loading entry effect on the loop — server-side polling that runs for sessions nobody is watching. After-rescue timeouts and app-machine housekeeping stay quiet.
