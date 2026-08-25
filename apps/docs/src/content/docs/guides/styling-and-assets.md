---
title: Styling and assets
description: "Global CSS, Tailwind, images, and WASM without a bundler plugin — why there is none, and what to do instead."
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

## Images and files

Static images belong in `static/` and are referenced by URL. Fingerprinting and long-lived caching are a deploy concern — put a CDN or cache headers in front of `/static/`.

On-the-fly optimization (resizing, format negotiation) is not a framework feature today. Use an image CDN in front of your origin, or mount a plain handler on the break-glass [`.hono`](/guides/middleware/) app. A first-class image route — options as query parameters, bytes produced on the server, conditional GET keeping repeats cheap — is the shape this takes when a real app needs it. It will be a URL, not an import, so it applies to any `<img>` anywhere.

## WASM

A `.wasm` file is an asset, not a transform. In an island, reference it relative to the module and instantiate it with the platform API:

```ts
const wasmUrl = new URL('./filter.wasm', import.meta.url)
const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl))
```

The island bundler emits the file beside the island's script with a hashed name and rewrites the URL, and it is served as `application/wasm`. No import syntax, no plugin — the same two lines work in any bundler and in none. A module hosted inside a Web Worker follows the same idiom with more wiring of your own, and is the one shape not yet exercised in the framework's own tests.

## What this is not

It is not a promise that every bundler feature has a Stator equivalent. Code splitting between islands, and transforms of island code itself, are the bundler's business and stay inside it. If something genuinely needs a transform on island code, open an issue with the use case — that evidence is what decides whether a mechanism gets built.
