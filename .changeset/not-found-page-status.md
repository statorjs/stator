---
"@statorjs/stator": minor
---

A `routes/404.stator` (or `404.ts`) page answers 404 without setting the status. Its response used to start at 200 like any page, so a not-found page that forgot `Stator.response.status = 404` answered every unknown URL with a 200 and, when nothing else withdrew the proof, a derived `Cache-Control`. The response now starts at 404; setting `Stator.response.status` still overrides it.
