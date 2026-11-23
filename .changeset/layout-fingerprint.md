---
'@statorjs/stator': patch
---

A page whose layout no longer matches what the server renders for it reloads instead of taking patches. Signing in or out in another tab, or going Back to a page after signing in, could leave a tab with one session's page receiving another's updates; where the template chose markup with a plain `{x ? … : …}` on claims or machine state, values landed on the wrong elements until the page was reloaded. Each page now carries a fingerprint of its binding layout, the server compares it on `/__sse` and `/__events`, and a mismatch reloads the page once. An event sent from such a page still takes effect. `when(read(machine, …))` branches were never affected.
