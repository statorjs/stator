---
'@statorjs/stator': minor
---

Derived Cache-Control now sees request reads, and claims peeks are precise.

A page or data route that reads a request header or a cookie — `request.headers.get(...)`, the cookie jar's `get`/`getSigned` — is no longer cache-marked as anonymous-identical: the read marks the response as varying per visitor and withdraws the proof. Previously a page that branched on `Accept-Language` or a marker cookie still carried `public, s-maxage`, so its first visitor's variant was cached for everyone. `request.raw.headers` stays untracked as the escape hatch, outside the proof.

A claims read withdraws the proof only when it resolves to a value. Anonymous visitors and cookied visitors with no claims saw the same page, so it stays cacheable; only a visitor who actually has claims gets an origin render. And route pages can read claims now — `Stator.request.claims()`, the same peek the `claims()` helper gives API routes and middleware, never establishing a session — so an admin-only affordance on a public page costs the public nothing.
