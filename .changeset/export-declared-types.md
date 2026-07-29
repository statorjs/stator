---
"@statorjs/stator": patch
---

Four documented types are now actually importable: `EntryEffect` and `AfterEntry` from `@statorjs/stator/machine` (the field types of the public `StateNode` shape), and `DispatchResult` / `DispatchError` from `@statorjs/stator/client` (what island `dispatch()` resolves with — previously described in the reference but unreachable for annotations). Type-only, no runtime change.
