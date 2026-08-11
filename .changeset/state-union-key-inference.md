---
"@statorjs/stator": patch
---

`defineMachine`'s state union is inferred from the `states` map's keys alone — every interior `S` position (`to:` targets, the machine-level `on:` map) is now `NoInfer`. Previously `to:` string literals were competing inference candidates, so whenever the transition graph didn't happen to target every state the union silently collapsed to the covered subset: valid definitions failed to typecheck (`initial` rejected, selector maps degraded to their default) as soon as duplicated per-state handlers moved to machine-level `on:`. Surfaced by the store's cart machine; regression-pinned in the machine-level `on:` tests.
