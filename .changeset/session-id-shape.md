---
"@statorjs/stator": major
---

A `stator_sid` cookie is used only if it has the shape of an id the server issues (a UUID). Any other value, such as an id a client chose, is ignored and the visitor gets a fresh session. Before, any string became a session id, so a session could be fixed in advance of a sign-in that didn't rotate it. Tests that hand-craft a session cookie should take it from a response's `Set-Cookie` or use `crypto.randomUUID()`.
