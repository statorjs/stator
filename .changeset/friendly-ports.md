---
"@statorjs/stator": patch
---

Port collisions stopped being stack traces. The dev server now shifts to the
next free port when the requested one is busy (noted in the banner) and
probes a free HMR websocket port, so two Stator apps run side by side
without fighting over 24678. Production stays strict about its port but
fails with a one-line message instead of an unhandled `EADDRINUSE`.
