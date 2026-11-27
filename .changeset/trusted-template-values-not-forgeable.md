---
'@statorjs/stator': patch
---

A value parsed from JSON can no longer pass for trusted template output. The template layer recognised an `html`/`raw()` fragment, an `each`/`when`/`match`/`defer` region and a `read()` result by plain properties, which any JSON object can carry, so JSON from a store, a remote API or an event payload could be rendered as raw markup. These values are now branded with `Symbol.for` keys, which `JSON.parse` and structured clone cannot produce, and two copies of the package in one process still recognise each other's values. A look-alike object now renders as escaped text. A `read()` slot id is also escaped where it is written. App code that uses the template functions is unaffected; code that built these objects by hand (`{ __isHtmlFragment: true, html }`) or kept a fragment in machine context and relied on it rendering after a JSON round trip now gets escaped text, and should call `raw()` at render time instead.
