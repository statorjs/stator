---
title: "overview"
description: "The package's subpath exports and what stability you can rely on."
sidebar:
  order: 1
---

Everything you import from `@statorjs/stator` comes through an explicit subpath — there is no root export.

## Subpaths

| Subpath | What it is | Stability |
| --- | --- | --- |
| [`/server`](/reference/server/) | App assembly, routing, dispatch, stores | Stable |
| [`/machine`](/reference/machine/) | The isomorphic state-machine engine (browser-safe) | Stable |
| [`/template`](/reference/template/) | `html`, `read`, control flow, directives | Stable |
| [`/client`](/reference/client/) | Island authoring: `StatorElement`, `use`, `bind`, `dispatch` | Stable |
| [`/dev`](/reference/dev-and-build/#createdevapp) | The Vite-embedded dev server | Stable |
| [`/build`](/reference/dev-and-build/#buildapp) | Production build + type sync | Stable |
| [`/components`](/reference/components/) | Built-in server components (`JsonLd`) | Stable |
| `/compiler` | The `.stator` compiler | Internal |
| `/vite` | The Vite plugins the dev server and build use | Internal |

## Stability policy

The seven stable subpaths are semver-stable: their exports only break in a major. `compiler` and `vite` are internal seams — they exist as subpaths because the framework's own tooling imports them, but their shapes may change in a minor. Don't build on them.

## TypeScript source, by design

The package ships its `src/` TypeScript directly — no `dist/`, no bundles. Vite (dev, islands) and tsx (production server) consume TS natively, so a build step would only add a layer where sourcemaps and stack traces can lie. Your app's toolchain must be able to load TS, which every supported entry point already is.
