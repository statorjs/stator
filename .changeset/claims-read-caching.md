---
'@statorjs/stator': patch
---

A GET that reads claims is never marked `Cache-Control: public`. It was marked when the read found no claims, which let a shared cache serve the anonymous page to a signed-in visitor of the same URL. Pages and data routes that read claims are now served from the origin for everyone; middleware that calls `claims()` on every request withdraws derived caching from every page, so read claims only on the paths that need them. A hand-set `Cache-Control` still wins.
