---
"@statorjs/stator": minor
---

A client-machine `read()` takes a fallback for the island's shell. The shell is server HTML and a client machine does not exist there, so `{read(cart, (c) => c.count)}` rendered empty text and `hidden={read(...)}` rendered no attribute until the island's script ran; on a cached page that was the first paint. `read(cart, (c) => c.count, props.count)` renders the third argument in the shell, as text or as the attribute's value, and the read replaces it when the island connects. The fallback is a shell expression (a literal, a prop, a fence value) and cannot read a client machine. A read without one renders as before.
