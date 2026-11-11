---
"@statorjs/stator": minor
---

Client machines: three fixes.

- `@statorjs/stator/client` imports without a DOM, so a `machine()` definition can be handed to `createActor` in a Node test. Constructing a `StatorElement` without a DOM throws, naming `// @env happy-dom`.
- A `use()` handle has `state`, the current state's name, typed to the machine's state names. A context key or selector named `state` takes its place.
- A `machine()` context that uses `on`, `select`, `name` or `events` as a key gets a type error on that key naming it, in place of "No overload matches this call" against every key.
