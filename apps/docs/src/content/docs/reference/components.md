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

type ImageProps = {
  src: string          // image-endpoint path (/media/…) or a remote URL
  width: number        // dimensions are REQUIRED, always — renders never probe;
  height: number       // store intrinsic size at upload via probeImage()
  alt: string          // required; decorative images say alt=""
  sizes?: string       // default '100vw' when a srcset applies
  crop?: number        // cover-crop ratio (w/h); 1 = square, 16 / 9 = widescreen
  format?: 'jpg' | 'png' | 'webp' | 'avif'
  widths?: number[]    // srcset candidates; mirror images.widths if changed
  decoding?: 'sync' | 'async' | 'auto'   // default 'async'
  class?: string
} & (
  // The shorthand OR the attributes it stands for — never both.
  | { priority?: boolean; loading?: never; fetchpriority?: never }
  | { priority?: never; loading?: 'eager' | 'lazy'; fetchpriority?: 'high' | 'low' | 'auto' }
)

type PictureProps = ImageProps & {
  formats?: ImageFormat[]        // <source> chain, default ['avif', 'webp']
  sources?: PictureSource[]      // art direction — different geometry per media condition
}

interface PictureSource {
  media: string          // e.g. '(max-width: 30rem)'
  crop: number           // width / height of the crop; 1 = square, 16 / 9 = widescreen
  sizes?: string
  widths?: number[]
}
```

`<Image>` emits one `<img>` with `width`/`height` always present (the browser reserves the aspect-ratio box before any bytes load), a `srcset` over the [image endpoint](/guides/styling-and-assets/#images) for endpoint-served sources, and `loading="lazy"` + `decoding="async"` defaults. `<Picture>` wraps it in modern-format `<source>` elements with the stored format as fallback, and collapses to a plain `<img>` when no source applies (a remote URL, or an image smaller than every candidate width). `getImage()` is the pure resolver beneath both — pass it the same options and place the returned `src`/`srcset`/`width`/`height` in your own markup.

**Cropping.** `crop` is a ratio the endpoint cover-crops to (`?w=&h=`), and the reported `width`/`height` describe the *cropped* result, so the reserved box matches what actually arrives. The ratio must be on the endpoint's allowlist (`images.aspectRatios` — square, 4:3, 3:2, 16:9 and their portrait duals by default); one the endpoint would reject is a render **error**, never a silently dropped source. Use `sources` when the geometry *varies by breakpoint* — art direction, the genuinely hard mode of `<picture>`: each entry crops under its media condition, crossed with every format *including the stored one* (without that row, a browser with no modern-format support would fall past the media condition to the uncropped fallback), and a per-source `crop` overrides the component-level one for that breakpoint. A single fixed geometry — a thumbnail grid — is just `crop` on the component, no media query required. Inside a configured app, srcset widths and crop validation read the resolved config from the render state, so component output can't drift from what the endpoint accepts.

**Loading control.** Pass `priority` for the one above-the-fold image and it means `loading="eager"` + `fetchpriority="high"` — lazy-loading a hero is the classic self-inflicted LCP regression. That rollup assumes a hero, though, and a grid wants its whole first row eager with only the first at high priority, so `loading`, `fetchpriority`, and `decoding` are settable directly with their native names and values. The shorthand and the attributes it stands for are mutually exclusive in the types: `<Image priority loading="lazy">` has no defensible meaning, so it fails to typecheck rather than resolving silently.

Remote URLs (`http…`) render untouched: no srcset, no proxying, no transforms — and they require dimensions exactly like everything else, which is what keeps every `<Image>` CLS-safe by construction. GIFs and SVGs render as originals only.
