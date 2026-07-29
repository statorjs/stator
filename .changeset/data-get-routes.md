---
"@statorjs/stator": minor
---

Data GET routes: `defineApiRoute({ method: 'GET', reads, handler })` declares a read-only data route — the handler receives `machines` (read proxies keyed by machine name, the same shape a page render context uses) and structurally no `dispatch`, which is what makes handler reads safe. Machines hydrate under the session lock and the lock is released before the handler runs. A plain return value is served as JSON; a string takes its `Content-Type` from the URL's extension (`routes/feed.xml.ts` serves `/feed.xml` as `application/xml`; also `.txt`, `.ics`, `.csv`); a raw `Response` passes through verbatim. Synthesized responses carry a strong `ETag` and answer `If-None-Match` with a bodyless 304. Extension-named route files that export nothing route-shaped now error at discovery instead of being skipped, `/__sse` and `/__events` refuse route keys that target data routes, and the dev server warns when a `public/` file shadows a data route's URL.
