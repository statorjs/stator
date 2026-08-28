---
title: "components"
description: "Built-in server components — Image/Picture for CLS-safe responsive images, JsonLd for typed structured data."
sidebar:
  order: 7
---

`@statorjs/stator/components` holds the framework's built-in server components.

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

## Image / Picture

```ts
function Image(props: ImageProps): HtmlFragment
function Picture(props: PictureProps): HtmlFragment
function getImage(opts: GetImageOptions): ResolvedImage

type ImageDims =                       // dimensions are REQUIRED, always —
  | { width: number; height: number }  // renders never probe; store intrinsic
  | { width: number; aspectRatio: number }  // size at upload via probeImage()

type ImageProps = ImageDims & {
  src: string          // image-endpoint path (/media/…) or a remote URL
  alt: string          // required; decorative images say alt=""
  sizes?: string       // default '100vw' when a srcset applies
  priority?: boolean   // eager + fetchpriority=high for the LCP image
  format?: 'jpg' | 'png' | 'webp' | 'avif'
  widths?: number[]    // srcset candidates; mirror images.widths if changed
  class?: string
}

type PictureProps = ImageProps & {
  formats?: ImageFormat[]        // <source> chain, default ['avif', 'webp']
  sources?: PictureSource[]      // art direction — different geometry per media condition
}

interface PictureSource {
  media: string          // e.g. '(max-width: 30rem)'
  aspectRatio: number    // width / height of the crop; 1 = square, 16 / 9 = widescreen
  sizes?: string
  widths?: number[]
}
```

`<Image>` emits one `<img>` with `width`/`height` always present (the browser reserves the aspect-ratio box before any bytes load), a `srcset` over the [image endpoint](/guides/styling-and-assets/#images) for endpoint-served sources, `loading="lazy"` + `decoding="async"` defaults, and the `priority` escape hatch (`eager` + `fetchpriority="high"`) for the one above-the-fold image — lazy-loading a hero is the classic self-inflicted LCP regression. `<Picture>` wraps it in modern-format `<source>` elements with the stored format as fallback, and collapses to a plain `<img>` when no source applies (a remote URL, or an image smaller than every candidate width). `sources` is art direction — the genuinely hard mode of `<picture>`: each entry serves a different *geometry* under its media condition (the endpoint cover-crops via `?w=&h=`), crossed with every format *including the stored one* (without that row, a browser with no modern-format support would fall past the media condition to the uncropped fallback). The crop ratio must be on the endpoint's aspect allowlist (`images.aspectRatios` — square, 4:3, 3:2, 16:9 and their portrait duals by default), and a ratio the endpoint would reject is a render **error**, never a silently dropped source. Inside a configured app, srcset widths and aspect validation read the resolved config from the render state, so component output can't drift from what the endpoint accepts. `getImage()` is the pure resolver beneath both — pass it the same options and place the returned `src`/`srcset`/`width`/`height` in your own markup.

Remote URLs (`http…`) render untouched: no srcset, no proxying, no transforms — and they require dimensions exactly like everything else, which is what keeps every `<Image>` CLS-safe by construction. GIFs render as originals only.
