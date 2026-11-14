---
"@statorjs/stator": patch
---

Rotating or clearing a session (`rotateSession()`, `clearSession()`, sign-in and sign-out flows) hangs up the live connections opened under the old id. They stayed registered and kept receiving their page's app-machine updates, so a tab left open after a sign-out, or a stream held with a stolen cookie, outlived the session it was opened under. Each browser reconnects with its new cookie, and the page's guards decide afresh.
