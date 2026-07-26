---
"@statorjs/stator": minor
---

Event dispatch now signals its state instead of failing silently. The dispatching element carries `data-stator-pending` while its POST is in flight, live routes carry `data-stator-connection` on `<html>` (`connected` / `disconnected` / `stale`), every request gets a 10-second deadline instead of hanging on browser defaults, and failures fire a `stator:dispatch-error` window event (also shown as a row in the dev inspector). Island `dispatch()` results gain an `error` field saying whether the failure was `network`, `timeout`, or `http`.
