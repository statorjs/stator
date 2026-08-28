---
title: Styling and assets
description: "Global CSS, Tailwind, fonts, images, and WASM without a bundler plugin — why there is none, and what to do instead."
sidebar:
  order: 3.5
---

Stator has no bundler plugin surface. There is no `vite.config.ts` to fill in, no `plugins` key in `stator.config.ts`, and a bundler plugin you install does nothing. That is a decision, not a gap, and this page is what to do instead.

## Why there is no plugin surface

Server templates never pass through a bundler. A `.stator` file compiles to a plain server module and runs as-is, in development and in production — no module graph, no transform pipeline. The only code Stator bundles is the [client island](/guides/client-components/) layer, and islands are deliberately thin leaves.

A bundler plugin would therefore reach islands and nothing else. Tailwind wired through a bundler plugin scans the island module graph and misses every class in a server template. An image plugin rewrites imports in island code and never sees the `<img>` in a route. Each of these works in a demo and quietly splits your app into a tier where the plugin applies and a tier where it doesn't — the server/client and dev/prod divergence Stator exists to remove.

So the needs people reach for plugins to solve are met outside the bundler, where they apply to the whole app.

## Global CSS

`static/` is served as-is under `/static/`. A stylesheet there is linked from your layout like any other:

```astro
<link rel="stylesheet" href="/static/site.css">
```

Component-scoped rules live in each file's `<style>` block — see [Scoped styles](/guides/scoped-styles/). The two compose: global CSS for the design system, scoped blocks for the component.

## Tailwind

Tailwind is a file scanner that emits one stylesheet. It wants source globs, not a module graph — which is why it works with Rails, Django, and PHP, and why it works here. Point it at every directory that carries classes, server templates and islands alike, and link the output:

```bash
pnpm add -D tailwindcss @tailwindcss/cli
```

```css
/* styles/tailwind.css */
@import "tailwindcss";
@source "../routes";
@source "../templates";
```

```json
{
  "scripts": {
    "css": "tailwindcss -i styles/tailwind.css -o static/tailwind.css --watch",
    "dev": "stator dev",
    "build": "tailwindcss -i styles/tailwind.css -o static/tailwind.css --minify && stator build"
  }
}
```

```astro
<link rel="stylesheet" href="/static/tailwind.css">
```

Run `css` beside `stator dev` (a second terminal, or a `concurrently` script). Because the scan covers `routes/` and `templates/`, a class used only in a server template is generated — the thing the island-plugin setup gets wrong.

## Fonts

A webfont is files plus CSS — no bundler is involved anywhere in the pipeline. What font tooling in other frameworks actually automates is self-hosting, `@font-face` generation, preload tags, and fallback metrics; all four are a few lines you own here.

Put the font files in `static/fonts/` — variable-weight `woff2` is usually the only format you need, and a [Fontsource](https://fontsource.org) package is the standard place to get them. A small copy script keeps the package as the source of truth (the `indie-blog` example's `scripts/sync-fonts.mjs` is the whole pattern: resolve the package, copy the latin variable files, run it from `predev`/`prebuild` and gitignore the output). Then declare the faces in your global stylesheet:

```css
@font-face {
  font-family: 'Inter Variable';
  src: url('/static/fonts/inter-variable.woff2') format('woff2');
  font-weight: 100 900;
  font-display: swap;
}

:root {
  --sans: 'Inter Variable', system-ui, sans-serif;
}
```

Preload the face your first paint uses, in the layout `<head>` — note `crossorigin` is required on font preloads even for same-origin files:

```html
<link rel="preload" href="/static/fonts/inter-variable.woff2" as="font" type="font/woff2" crossorigin>
```

`font-display: swap` means text renders immediately in the fallback and swaps when the font arrives. The layout shift that swap causes is tamed by a metrics-adjusted fallback — a second `@font-face` for a local system font with `size-adjust`/`ascent-override`/`descent-override` matched to the webfont, so the swap changes glyphs but not geometry. The numbers come from font metrics: [`@capsizecss/metrics`](https://github.com/seek-oss/capsize) publishes them per family, and the [fontaine](https://github.com/unjs/fontaine) formula turns them into overrides (`size-adjust` = the ratio of average character widths, then divide each vertical metric by it). Worked example — Literata falling back to Georgia, from the `indie-blog` example:

```css
@font-face {
  font-family: 'Literata Fallback';
  src: local('Georgia');
  size-adjust: 107.67%;
  ascent-override: 109.31%;
  descent-override: 28.61%;
  line-gap-override: 0%;
}
```

Stack it between the webfont and the raw system font: `font-family: 'Literata Variable', 'Literata Fallback', Georgia, serif`. Generating these numbers automatically is the part that becomes first-class here when a real app's log demands it.

Like everything in `static/`, font files are immutable in practice — put long-lived cache headers on them at the CDN or proxy.

## Images

Design-asset images (logos, icons, decorative art) belong in `static/`, referenced by URL, cached by the framework's static headers.

Content images — uploads, photos, anything runtime-written — get the framework's image endpoint. Declare where they live and the endpoint mounts:

```ts
// stator.config.ts
export default defineConfig({
  images: { dir: 'media' },   // originals here; endpoint serves /media/*
})
```

The endpoint's contract: **the URL's extension is the delivery format** — request `/media/2026/08/x.webp?w=800` and the stored `x.jpg` is converted and resized to honor it; the server never returns bytes that contradict an extension, and there is no `Accept`-header or user-agent negotiation. Widths come from an allowlist (`images.widths`, default `[400, 800, 1200, 1600]` — an open resize parameter is a denial-of-service invitation), variants cache on disk beside the originals, and every response carries an ETag with bodyless 304 revalidation. Transformation is sharp behind a swappable `ImageTransformer` adapter, loaded only when `images` is configured.

Rendering pairs with [`<Image>`/`<Picture>`](/reference/components/#image--picture): CLS-safe `width`/`height` always emitted, `srcset` over the endpoint, lazy by default with a `priority` mode for the one above-the-fold image, and art direction on `<Picture>` (different crops per media condition — the endpoint cover-crops with `?w=&h=`, widths from the allowlist and heights derived from the aspect allowlist). Dimensions always come from you — probe them **once at upload** with `probeImage()` and store them beside the file's path (renders are synchronous and never do image IO; intrinsic size is write-time data). Remote URLs render untouched (no proxying, no transforms) and require dimensions like everything else.

Uploads themselves stay app code: `request.formData()` delivers the `File`, you write it under `images.dir` (dated subpaths keep directories sane) and store the probed dimensions — the `indie-blog` example is the worked reference.

## WASM

A `.wasm` file is an asset, not a transform. In an island, reference it relative to the module and instantiate it with the platform API:

```ts
const wasmUrl = new URL('./filter.wasm', import.meta.url)
const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl))
```

The island bundler emits the file beside the island's script with a hashed name and rewrites the URL, and it is served as `application/wasm`. No import syntax, no plugin — the same two lines work in any bundler and in none. A module hosted inside a Web Worker follows the same idiom with more wiring of your own, and is the one shape not yet exercised in the framework's own tests.

## What this is not

It is not a promise that every bundler feature has a Stator equivalent. Code splitting between islands, and transforms of island code itself, are the bundler's business and stay inside it. If something genuinely needs a transform on island code, open an issue with the use case — that evidence is what decides whether a mechanism gets built.
