---
"@statorjs/stator": patch
---

`read()` and the region primitives (`each`/`when`/`match`/`defer`) are now compile errors inside `<textarea>` and `<title>`. Those elements hold raw text (RCDATA), so the live-slot wrapper or region markers rendered as literal markup — a textarea pre-filled via `read()` showed `<span data-slot="…">` to the user. The error points at the fix: interpolate a static value (a selector property access), or bind an attribute if it must be live. Attribute-position reads on the elements themselves stay legal.
