---
title: "components"
description: "Built-in server components — currently JsonLd for typed schema.org structured data."
sidebar:
  order: 7
---

`@statorjs/stator/components` holds the framework's built-in server components. There is one today.

## JsonLd

```ts
function JsonLd(props: JsonLdProps): HtmlFragment

interface JsonLdProps {
  json: Thing | Thing[]      // schema-dts types; an array renders as an @graph
  space?: string | number    // pretty-print indent
}
```

Renders a typed schema.org JSON-LD `<script type="application/ld+json">` block:

```astro
import { JsonLd } from '@statorjs/stator/components'
<JsonLd json={{ "@type": "Product", name: "Pocket Notebook" }} />
```

The payload is typed against `schema-dts`, gets `@context` added (or is wrapped as an `@graph` for an array), and is serialized with a replacer that escapes the HTML sequences JSON-LD forbids inside `<script>` — so a value containing `</script>` can't break out of the element. Use this rather than hand-writing the block through `raw()`: a literal `<script>` in a template would trip both text auto-escaping and the inline-script-is-a-client-component rule.

## Lower-level exports

- `ldToString(json, space?)` — the serializer `JsonLd` uses: one entity (with `@context`) or an `@graph`, escaped safe for verbatim embedding in a `<script>` element.
