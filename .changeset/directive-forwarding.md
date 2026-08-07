---
"@statorjs/stator": minor
---

`on:` event directives can now be forwarded to a component. `<Button on:click={() => cart.send(…)}>` no longer errors — the parent packs component-level directives into a reserved bag, and the component reads one back with `Stator.forwarded('on:click')` and re-attaches it to whichever inner element it chooses (`<button on:click={onClick} {...rest}>`). This keeps directive syntax on both sides and leaves placement to the component author (no forced forwarding to the root). A forwarded handler that's absent renders no binding rather than crashing. `bind:`/`ref:` forwarding and client-island forwarding are not yet supported.
