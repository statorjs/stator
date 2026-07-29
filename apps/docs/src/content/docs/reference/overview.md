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
| [`/server`](/reference/server/) | App assembly, routing, dispatch, stores | Stable + Toolchain |
| [`/machine`](/reference/machine/) | The isomorphic state-machine engine (browser-safe) | Stable |
| [`/template`](/reference/template/) | `html`, `read`, control flow, directives | Stable + Toolchain |
| [`/client`](/reference/client/) | Island authoring: `StatorElement`, `use`, `bind`, `dispatch` | Stable |
| [`/dev`](/reference/dev-and-build/#createdevapp) | The Vite-embedded dev server | Stable |
| [`/build`](/reference/dev-and-build/#buildapp) | Production build + type sync | Stable |
| [`/components`](/reference/components/) | Built-in server components (`JsonLd`) | Stable |
| `/compiler` | The `.stator` compiler | Internal |
| `/vite` | The Vite plugins the dev server and build use | Internal |

## Stability policy

There are three tiers:

- **Stable** — the documented authoring surface: every symbol with its own section on a reference page. Semver-stable; these break only in a major.
- **Toolchain** — the symbols listed under a reference page's **"Lower-level exports"** heading on [`/server`](/reference/server/#lower-level-exports) and [`/template`](/reference/template/#lower-level-exports). They're public for one structural reason: the dev server loads the runtime through Vite, and modules shared between the Vite graph and the Node graph must be importable via a package specifier. Compiled `.stator` output also imports a few of them — always against the same package version that compiled it. These may change in a **minor**. Don't build application code on them; if one turns out to be genuinely useful, tell us and we'll promote it.
- **Internal** — `compiler` and `vite`. They exist as subpaths because the framework's own tooling imports them; their shapes may change in a minor. Don't build on them.

The lower-level lists on [`/machine`](/reference/machine/#lower-level-exports) and [`/client`](/reference/client/#lower-level-exports) are **Stable** — they're type-level surface your app legitimately types against (`InstanceOf`, `EventOf`, `DispatchResult`, …), not runtime plumbing.

## TypeScript source, by design

The package ships its `src/` TypeScript directly — no `dist/`, no bundles. Vite (dev, islands) and tsx (production server) consume TS natively, so a build step would only add a layer where sourcemaps and stack traces can lie. Your app's toolchain must be able to load TS, which every supported entry point already is.
