---
"@statorjs/stator": patch
---

Dev inspector: the toolbar is now a `<stator-inspector>` custom element with a shadow root, so an app's global styles (e.g. a bare `button` reset) can no longer restyle it. The element flash stays document-level in the lowest-priority `@layer stator-inspector` — the app still always wins over anything the inspector paints on the page.
