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

## What build:lib checks and stamps

Every compiled module starts with a stamp naming the compiled-shape contract it speaks and the Stator version that produced it, `/* @stator contract=1 compiler=3.0.0 */`. The contract is the interface between compiled components and the runtime they run on, and it changes only when that interface does, not with every release.

For a component with a `<script>` (an island), `build:lib` also makes the published client entry stand on its own. A default import of a server machine becomes the machine's `{ name }`, which is all an island dispatches by, so the machine's code never reaches the browser. Then each client entry is bundled for the browser as a check, and the publish fails, naming the file and the import, if anything it reaches imports a Node built-in or a server-side Stator module. `build:lib` lists the machines the islands dispatch to: a consuming app registers those.

Compiled modules carry inline source maps pointing at the `.stator` file beside them, so ship the sources too.

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

## Shipping islands

An island ships like any other component: its compiled `x.stator.ts` shell, the `x.stator.client.ts` entry `build:lib` writes beside it, its `.css`, and its `.stator` source. A consuming app needs nothing more than the import. When a route reaches the shell, directly or through the library's own server components, `stator dev` and `stator build` bundle the client entry with the app's islands, sharing one copy of the client runtime, and add its script to that route's `<head>`. Its manifest key and asset name come from the package name and its path inside the package, so they can't clash with the app's.

Three things are checked where the walk finds them, and `stator build` fails, listing every problem at once:

- **The contract stamp.** Every reached library component has to carry the contract the app's Stator reads. A component compiled for another contract, or before stamps existed, refuses the build, naming the package and both versions. Install a version of the library built for your Stator, or ask its author to republish. `stator check` runs the same check.
- **Custom element tags.** Two islands defining one tag, from two libraries or a library and the app, fail the build naming both sources, since the page could upgrade only one of them. Give a library's tags a package prefix, as design systems do. `stator dev` logs the collision with the route that reached the second island, and keeps serving the first.
- **Machines.** A library island dispatches by machine name, and the app is what registers machines. When a reached island dispatches to a machine the app's `machines/` doesn't have, the build fails naming the island and the machine. Re-export the library's machine from `machines/`. `stator dev` logs the same message.

## Limits

- **Type declarations ride the compiled `.ts`.** Each compiled module carries the component's prop signature, so `stator check` and the editor see library props without a separate `.d.ts` step.
