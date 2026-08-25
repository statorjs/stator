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
| [`/client`](/reference/client/) | Island authoring: `StatorElement`, `use`, `machine`, `dispatch` | Stable |
| [`/dev`](/reference/dev-and-build/#createdevapp) | The dev server | Stable |
| [`/build`](/reference/dev-and-build/#buildapp) | Production build + type sync | Stable |
| [`/components`](/reference/components/) | Built-in server components (`JsonLd`) | Stable |
| `/compiler` | The `.stator` compiler | Internal |

## Stability policy

There are three tiers:

- **Stable** — the documented authoring surface: every symbol with its own section on a reference page. Semver-stable; these break only in a major.
- **Toolchain** — the symbols listed under a reference page's **"Lower-level exports"** heading on [`/server`](/reference/server/#lower-level-exports) and [`/template`](/reference/template/#lower-level-exports). They're public for one structural reason: compiled `.stator` output imports a few of them — always against the same package version that compiled it — and the framework's own tooling (the dev server, the build) shares the rest. These may change in a **minor**. Don't build application code on them; if one turns out to be genuinely useful, tell us and we'll promote it.
- **Internal** — `compiler`, plus the bundler glue the framework's own tooling imports. They exist as subpaths only for that tooling; their shapes may change in a minor. Don't build on them. In particular there is no bundler plugin surface: Stator never reads a `vite.config.*` and accepts no plugins — see [Styling and assets](/guides/styling-and-assets/) for what to do instead.

The lower-level lists on [`/machine`](/reference/machine/#lower-level-exports) and [`/client`](/reference/client/#lower-level-exports) are **Stable** — they're type-level surface your app legitimately types against (`InstanceOf`, `EventOf`, `DispatchResult`, …), not runtime plumbing.

## TypeScript source, by design

The package ships its `src/` TypeScript directly — no `dist/`, no bundles. The dev server's loader, the island bundler, and the production server all consume TS natively, so a build step would only add a layer where sourcemaps and stack traces can lie. Your app's toolchain must be able to load TS, which every supported entry point already is.
