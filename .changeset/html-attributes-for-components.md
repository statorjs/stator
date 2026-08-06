---
"@statorjs/stator": minor
---

Components can extend a native element's attributes with `HTMLAttributes<Tag>` — `Stator.props<HTMLAttributes<'button'> & { variant }>()` types and validates every native button attribute plus the component's own props, with no per-attribute forwarding. Attribute values accept live `read(…)` bindings as well as literals. Separately, `JSX.IntrinsicElements` is now typed per element, so a typo on a plain element (`<button typ=…>`) is a compile error; custom-element islands, `raw()` SVG, and unlisted tags stay permissive.
