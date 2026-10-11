---
"@statorjs/stator": patch
---

`HTMLAttributes<'button'>` and `HTMLAttributes<'input'>` now type the per-button form submission overrides: `formaction`, `formenctype`, `formmethod`, `formnovalidate` and `formtarget`. A submit button that targets a different endpoint inside one form no longer needs a spread cast.
