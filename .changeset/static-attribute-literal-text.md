---
'@statorjs/stator': patch
---

A static attribute in a `.stator` template renders as exactly the text written. The compiler emitted it with `JSON.stringify`, so `title='say "hi"'` produced a broken attribute, `data-config='{"a":1}'` was cut short, a backtick made the compiled module a syntax error, and `title="Price: ${price}"` was evaluated as an interpolation. Static values are now HTML-escaped and escaped for the template literal. If a template relied on `${…}` inside a quoted attribute being interpolated, it now gets the literal text: write the whole value as an expression instead, `title={`Price: ${price}`}`. Likewise an HTML entity in a static attribute is now literal text, so write `title="Tom & Jerry"`, not `title="Tom &amp; Jerry"`, matching how a component prop already behaved. A `<!doctype>` with a backtick or `$`, and a `<children name="…">` that is not a JS identifier, are also emitted correctly now.
