---
"@statorjs/stator": patch
---

A client-machine `read()` accepts a selector that takes no argument. `read(state, () => false, true)` compiled to a call that passed the instance to a function declaring no parameter, so `stator check` failed with "Expected 0 arguments, but got 1" at the read. The selector is still called with the instance, so the machine stays the binding's dependency.
