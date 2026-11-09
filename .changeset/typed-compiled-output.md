---
"@statorjs/stator": patch
---

Compiled output typechecks in the app that imports it. A route's `Stator.reads` handles carry their machine types, the same `InstanceOf` the editor uses, and a component without props accepts the empty props object its callers pass. A library's compiled pages and components then pass `stator check` in a strict consuming app. Runtime output is unchanged.
