---
title: Component libraries
description: "Publishing .stator components as a package: the publish-time compile, the exports map, sibling CSS, and what a consuming app does (nothing)."
sidebar:
  order: 3.7
---

A package can ship `.stator` components, scoped styles included. A consuming app composes them like its own — `import { Hero } from '@acme/blocks/components'` and `<Hero />` — and picks up their CSS per route, in dev and in the production build alike. The framework's own `<Image>` and `<Picture>` ship this way.

## What a library ships

**Compiled output, not `.stator` source.** Both the dev server and the production build treat `node_modules` as an already-resolved boundary: they never compile anything inside it. So a library compiles its components before publishing — each `x.stator` becomes a sibling `x.stator.ts` (the server render module) plus `x.stator.css` when it has a `<style>` block. Svelte and Vue libraries have always worked this way.

The CLI owns that step. `stator build:lib [dir]` walks the directory (default `src`), writes each component's siblings, rewrites `.stator` imports between them to the compiled modules, and aggregates the stylesheet described below. Wire it into `prepublishOnly`, or a workspace `build` script, and commit nothing it writes:

```json
{
  "scripts": { "prepublishOnly": "stator build:lib src" }
}
```

The same operation is `compileLibrary()` on `@statorjs/stator/build` for a script that needs to do more around it.

## The exports map decides CSS granularity

A consuming build walks its own import graph file by file, but stops at a bare specifier: it resolves `${specifier}.css` through the package's `exports` map, once, and takes whatever that returns. The library's layout is opaque to it. So **the granularity of CSS a consumer gets follows the specifier it imports, not how the files are laid out.**

A barrel ships one stylesheet for everything it re-exports:

```json
{
  "exports": {
    "./components": "./src/index.ts",
    "./components.css": "./src/components.css"
  }
}
```

That `components.css` is the aggregate of every sibling `.css` the barrel's entry reaches. The framework does the same for `@statorjs/stator/components`, and it's the right call while most of a library is reached from every page anyway.

Per-component subpaths give per-component CSS, with the same consumer and the same tracer:

```json
{
  "exports": {
    "./hero.stator": "./src/hero.stator.ts",
    "./hero.stator.css": "./src/hero.stator.css"
  }
}
```

An app importing `@acme/blocks/hero.stator` then pulls in only the hero's styles. Emitting those entries is a few lines in the compile script. Both shapes can coexist.

## Packaging the compiled siblings

The compiled `.stator.ts` and `.css` files are usually gitignored, and packing — `npm pack`, and `pnpm deploy` for a workspace package — reads `.gitignore` unless an `.npmignore` exists. A `files` field alone doesn't rescue gitignored files inside the directories it lists, so the siblings silently don't ship and the consumer's first import fails to resolve. Declare `files`, and add an `.npmignore` so packing stops consulting `.gitignore`:

```json
{ "files": ["src", "scripts"] }
```

```
# .npmignore — present so packing stops consulting .gitignore; the compiled
# .stator.ts/.css siblings under src/ are gitignored but must ship.
node_modules
```

## Consuming a library

Nothing to configure. `stator dev` resolves each bare specifier's sibling CSS into `/static/components.css` as the module graph reaches it; `stator build` folds it into the per-route stylesheet of every route that reaches the component — including through an inactive `match`/`when`/`each` arm, since a live update can activate the arm with no fresh request. See [Scoped styles](/guides/scoped-styles/).

## Limits

- **Islands stay in the app.** Island discovery walks the app tree only, so a library can't ship a client component yet. Server components compose freely; a `<script>` component has to live under the app's own `templates/`.
- **Type declarations ride the compiled `.ts`.** Each compiled module carries the component's prop signature, so `stator check` and the editor see library props without a separate `.d.ts` step.
