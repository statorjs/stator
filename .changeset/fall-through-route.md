---
'@statorjs/stator': patch
---

A page served by a catch-all route after another route answered 404 now gets its live updates and events from the route that rendered it. Before, `/__sse` and `/__events` used the first route matching the path, so such a page was patched from a different template and its events were checked against the wrong route. The page names its route in a `stator-pattern` meta, which the client echoes; pages served by their first match send nothing new.
