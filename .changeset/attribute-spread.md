---
"@statorjs/stator": minor
---

Attribute spread `{...rest}` now works in templates, on both elements and components. `<button {...rest}>` forwards a bag of attributes onto the element — static values (with the shared boolean/url semantics) and live machine `read(...)` values, which become real attribute bindings that patch on events — and `<Card {...rest} />` spreads into the component call in source order. This makes the `HTMLAttributes<Tag>` pattern practical: a component can extend a native element and forward every native attribute without hand-plumbing each one (`const { variant, ...rest } = Stator.props<HTMLAttributes<'button'> & { variant }>()` → `<button {...rest}>`). An item read (`read(item, …)`) or a directive invocation used as a spread value is rejected with a clear error.
