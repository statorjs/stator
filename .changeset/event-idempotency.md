---
"@statorjs/stator": minor
---

Event POSTs are now idempotent and retried. Every machine-event dispatch carries a client-generated `eventId`; the server caches the response per session and replays a duplicate verbatim instead of re-applying it (keyed-list patches are positional, so a double-apply was never safe). On top of that, the client retries network failures and timeouts twice with backoff, reusing the same id — a tap on flaky wifi now recovers instead of silently dropping. Non-2xx responses and enhanced form submits are never retried.
