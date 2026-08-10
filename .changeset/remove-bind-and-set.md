---
"@statorjs/stator": major
---

`bind:` and the engine's `@set` event are removed. Display is `read()`, everywhere — `{read(m, (s) => s.value)}` in text position, `attr={read(m, …)}` in attribute position, on server and client machines alike — and every state change is a declared, typed event through `on:`. The directive surface is now `on:` (events in) + `ref:` (identity). For form drafts, the input owns its text: platform constraints guard the draft, a typed event commits it (`ref:`/`FormData` at the boundary), and pre-fill is a server-rendered attribute. `bind:` anywhere is a located compile error with migration guidance.

Also removed: the deprecated one-bag `machine(config)` form (use `machine(context, behavior)`), and data-only client machines now accept no events at all (`send` is a compile error — they are seed-and-display). The wire's reserved `@`-prefix rejection stays as defense-in-depth.

Additional 2.0 surface trims: `defineDirective`/`invoke` and the `Directive*` types leave the public `/template` barrel (documented but unusable from `.stator` files — the directive namespace is closed; a future custom-directive system would be global configuration), and the `StatorDirectiveAttributes` type no longer advertises `bind:`/`class:*`/`style:*` forms the compiler rejects. The Toolchain tier of `/server` is documented as reserved to move to `@statorjs/stator/server/runtime` in a 2.x minor.
