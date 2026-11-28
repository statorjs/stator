---
'@statorjs/stator': minor
---

Request bodies can be capped. `requests.maxBodyBytes` in `stator.config.ts` sets a limit for every API route and anything middleware reads, and `maxBodyBytes` on `defineApiRoute` overrides it per route and method (`Infinity` for no limit). A body over its limit is refused with a `413` and `{ "error": "request body exceeds N bytes" }`: before the handler runs when `Content-Length` declares the size, otherwise while the body is read, so no more than the limit is buffered. A handler's read rejects with `BodyTooLargeError`, exported from `@statorjs/stator/server`; the response is the 413 whether the handler lets it throw, catches it or returns its own response. `/__events` keeps its own cap, `events.maxBytes`. No limit applies unless one is set; a body over 1 MiB on a route with none logs one warning per route, because 4.0 will default the limit to 1 MiB.
