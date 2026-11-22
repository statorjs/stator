---
'@statorjs/stator': patch
---

A live page told to reload for a new build no longer loops when a CDN is still serving the old page. It reloads once; if the page that comes back is still the old build it waits (5 s, then longer) before trying again, and shows `data-stator-connection="stale"` meanwhile. Before, a cache that ignored the reload's revalidation header kept the tab reloading many times a second until its entry expired.
