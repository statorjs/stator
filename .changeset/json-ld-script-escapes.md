---
"@statorjs/stator": patch
---

`<JsonLd>` now escapes `<`, `>` and `&` in the serialized payload as JSON `<`-style escapes instead of HTML entities. Script content is raw text to the HTML parser, so the old entities reached structured-data consumers literally (`20&apos;`, `plug &amp; play`); the JSON escapes decode back to the real characters while still preventing a `</script>` breakout. Quotes are no longer rewritten (`JSON.stringify` already handles them), and U+2028/U+2029 are escaped as well.
