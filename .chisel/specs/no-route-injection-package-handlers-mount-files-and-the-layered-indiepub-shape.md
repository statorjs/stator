---
title: 'No route injection: package handlers, mount files, and the layered IndiePub shape'
status: draft
created: 2026-08-29
updated: 2026-08-29
area: architecture
---

## What and Why

Recorded 2026-08-29 from the tonysull.co M2 session. Astro integrations inject routes directly into an app — IndiePub uses that for its entire surface (59 injected routes: ~35 admin UI, ~24 protocol). Rebuilding IndiePub on Stator raises the question: does Stator want a route-injection surface? This spec records the answer (no) and the shape that replaces it.

## Decision: no route-injection surface

Three grounds, one structural and two doctrinal:

1. **Stator cannot inject the interesting half.** Protocol endpoints (`defineApiRoute`) are runtime values a package could hand over, but pages are compiled `.stator` files — `Stator.reads` declarations, scoped CSS, island manifests, and live-route wiring are resolved at compile/build time. There is no runtime object a package could inject that IS a live admin page. IndiePub's admin UI (35 of the 59 routes) is exactly the half injection cannot reach without inventing a parallel runtime-page mechanism.
2. **The no-plugin-surface rule** (governing the images and toolchain specs): a plugin API is a second, unauditable program. Injection's first consequence — a collision-resolution config knob — is the first installment of that API, maintained forever.
3. **The audit-surface thesis**: read the tree, know the app. Routes no file in the codebase names break the promise at its root. The framework's one config-mounted route (the images endpoint) preserves it only because the mount is declared in the app's own `stator.config.ts`; extending config into third-party mounts would be the plugin system through the back door ("config owns how it runs, never what it does").

## The layered shape

1. **Protocol endpoints: package handlers + one-line mount files.** `routes/micropub.ts` containing `export { GET, POST } from '@indiepub/stator/micropub'`. Logic rides npm (spec-shaped code users must not fork; upgrades must flow); the mount is a file the user placed — visible, greppable, movable (collision resolution IS the filesystem), deletable, wrappable (import the handler, call it inside your own). Ecosystem-proven (NextAuth's `[...nextauth].ts`, every webhook SDK).
2. **Machines: package exports, re-exported through `machines/` files.** Discovery stays file-based, the tree names everything, chart logic upgrades via npm.
3. **Admin UI: scaffolded into the tree, composed from package components.** The scaffolder writes admin pages as thin compositions the user owns; upgrade friction is the already-documented "updating from a template" recipe, and it shrinks as pages stay thin because components live in the package.

## The flexibility ladder (the IndiePub product shape)

Three tiers, shipped outermost-first:

1. **Core logic as plain functions** — post-type discovery, feed generation, Micropub parsing, token verification. (Already true: `@indiepub/core` et al. are pure fetch/crypto and Node-portable.)
2. **Headless Stator components** — unstyled `.stator` components: markup + behavior + machine wiring, `class` props and `<children />` slots for the consumer's own styling.
3. **The fully styled layer** — the finished admin/theme components, which is where the Stator port starts.

A user enters at whichever tier matches how much they want to own; each tier is built ON the one below, so the layers cannot drift.

## The technical gate: package-shipped `.stator`

Whether a package can ship `.stator` files has never been exercised: compiler resolution out of `node_modules`, scoped-CSS concatenation, island bundling, and LSP intelligence across a package boundary. If it works, scaffolded admin pages are five-line compositions and customization is "swap a component." If not, the scaffold copies components into the tree (full shadcn mode) until it does. **Spike before designing anything further** — this is the real successor question to this spec.

## Evidence path and non-goals

The tonysull.co arc runs the experiment in the right order: M4 builds Micropub/IndieAuth in-tree; the subsequent extraction into `@indiepub/*` packages — with a production consumer keeping it honest — is what shows which lines want to be package logic vs tree wiring. No integration surface gets designed ahead of that extraction (the `bind:` lesson).

Non-goals: an `injectRoute` API; config-declared third-party route mounts; any plugin registry.
