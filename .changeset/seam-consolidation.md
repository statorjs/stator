---
"@statorjs/stator": patch
---

Seam consolidation: cross-tier contracts now have one implementation each. The attribute-value contract (`attrValue`/`sanitizeAttr`/`setAttr` in `wire/attr-value.ts`) is shared by static render, the live diff, the island writer codegen, and the wire applier — previously four drifting copies. Text interpolation shares `textValue` between render and patches, fixing a latent disagreement where a patched array value rendered comma-joined ("a,b") while the static render concatenated ("ab"). Island marker formats are shared constants (`wire/island-markers.ts`), and the component props type is computed once (`statorPropsType`) for both the `.d.ts` generator and the language-server virtual emit. New seam tests pin static-render ≡ patch-apply for attribute and text values, and `.d.ts` ≡ virtual-code props.
