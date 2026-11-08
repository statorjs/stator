---
title: Component libraries
description: "Publishing .stator components as a package: the publish-time compile, the exports map, sibling CSS, and what a consuming app does (nothing)."
sidebar:
  order: 3.7
---

A package can ship `.stator` components, scoped styles included. A consuming app composes them like its own — `import { Hero } from '@acme/blocks/components'` and `<Hero />` — and picks up their CSS per route, in dev and in the production build alike. The framework's own `<Image>` and `<Picture>` ship this way.

## What a library ships

**Compiled output, not `.stator` source.** Both the dev server and the production build treat `node_modules` as an already-resolved boundary: they never compile anything inside it. So a library compiles its components before publishing — each `x.stator` becomes a sibling `x.stator.ts` (the server render module) plus `x.stator.css` when it has a `<style>` block. Svelte and Vue libraries have always worked this way.

The CLI owns that step. `stator build:lib [dir]` walks the directory (default `src`), writes each component's siblings, rewrites `.stator` imports between them to the compiled modules, and aggregates the stylesheet described below. Scope ids are qualified by the package name from `package.json`, so two libraries with the same file layout never share a `data-s-<hash>` and one's scoped rules can't reach the other's markup. Wire it into `prepublishOnly`, or a workspace `build` script, and commit nothing it writes:

```json
{
  "scripts": { "prepublishOnly": "stator build:lib src" }
}
```

The same operation is `compileLibrary()` on `@statorjs/stator/build` for a script that needs to do more around it.

## CSS follows what a route reaches

A consuming app collects a route's CSS by walking its import graph. The walk crosses into a package at the bare specifier the app imports, follows that package's own relative imports, and continues into any Stator package it imports in turn, so a library component composing others is reached whole. Each reached component contributes its sibling `.css`, read by path beside the compiled module. A route gets the styles of exactly the components it can reach, the same way it does for the app's own components, however the library lays out its files or names its exports.

So the `exports` map only needs entries for what an app imports, a barrel or per-component subpaths, and no `.css` entries for Stator apps:

```json
{
  "exports": {
    "./components": "./src/index.ts",
    "./hero.stator": "./src/hero.stator.ts"
  }
}
```

`stator build:lib` still writes an aggregate `components.css` of everything the barrel reaches, for a page that is not a Stator app. Export it if you want that audience.

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

Nothing to configure. `stator dev` and `stator build` fold each reached library component's sibling CSS into the stylesheet of every route that reaches it, including through an inactive `match`/`when`/`each` arm, since a live update can activate the arm with no fresh request. The walk follows a library into the packages it imports, to any depth, as long as they are Stator packages (`@statorjs/stator` itself, or a package that depends on it), so a library component that renders `<Image>` brings `<Image>`'s CSS with it. Packages that don't depend on Stator are never walked. See [Scoped styles](/guides/scoped-styles/).

## Limits

- **Islands stay in the app.** Island discovery walks the app tree only, so a library can't ship a client component yet. Server components compose freely; a `<script>` component has to live under the app's own `templates/`.
- **Type declarations ride the compiled `.ts`.** Each compiled module carries the component's prop signature, so `stator check` and the editor see library props without a separate `.d.ts` step.
