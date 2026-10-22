---
"@statorjs/stator": patch
"create-stator": patch
---

Dependency refresh for 2.11: hono 4.13, @hono/node-server 1.19.17, sharp 0.35, esbuild 0.28, postcss 8.5.31. Picks up the upstream security fixes in each (hono CORS origin reflection, the libvips CVEs behind sharp, postcss source-map path traversal, node-tar via giget in create-stator).
