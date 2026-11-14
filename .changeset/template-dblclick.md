---
"@statorjs/stator": patch
---

A server template's `on:dblclick` is delivered. The page runtime never listened for it, so the binding rendered and then did nothing.

A server template binds `on:click`, `on:dblclick`, `on:submit`, `on:change` and `on:input`. Binding any other event is now a render error that names those five, where it used to render an attribute nothing would ever read. A client island's `on:` is unchanged and takes any DOM event.
