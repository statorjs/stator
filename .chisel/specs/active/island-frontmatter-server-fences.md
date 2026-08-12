---
title: "Island frontmatter: server fences in client-component files"
status: draft
created: 2026-08-11
updated: 2026-08-11
area: compiler
---

## Context

Staging a marketing screenshot found the gap: a `.stator` island (template +
`StatorElement` `<script>`) silently discarded its `---` fence — either a
dangling-identifier crash at first render or dead code that looked alive.
2.0.1 made that a located error ("islands render their shell from props"),
which was deliberate sequencing: this feature is now a pure error
relaxation, a clean minor.

The error is honest but the model it enforces is weaker than the intuitive
one. The intuitive read of a `.stator` file — held by its own author — is
Astro-shaped: fence runs on the server, template renders on the server (and
may use the fence), `<script>` ships to the browser. Two paper cuts already
point the same way: registration #3 (island shells can't see module
constants — `TICKETS` smuggled in as a prop) and the screenshot file itself,
where the one-file server/client story had to route DB-and-secrets talk
through comments because the fence couldn't exist.

## Decision

An island file may carry a frontmatter fence. It executes **server-side,
per shell render** — exactly a server component's contract — and its
bindings are in scope for the template. The `<script>` never sees it, in
either direction: fence bindings are not client globals, script members are
not fence scope. Three regions, two worlds, one file:

```
---  server: runs per render, on the server only
import { listSpecials } from '../lib/db.ts'
const specials = listSpecials(process.env.REGION)
---
<buy-button>
  <p>{specials[0].name}</p>          ← server-rendered shell, sees the fence
  <button on:click={buy}>Add</button> ← wired by the class at hydration
</buy-button>
<script>  browser: hydrates onto the server's DOM
  export class BuyButton extends StatorElement { … }
</script>
```

## Mechanics

**Emission** (`compiler/compile.ts` / `compileClient`): the island branch
stops erroring on a fence and instead runs the existing
`processFrontmatter` pipeline with a new capability row (below), then
assembles the shell module the way `emitComponent` does — fence imports
hoisted to module scope, fence body inside the render function, ahead of
`const __inner = …`. The CLIENT module is untouched: the fence never enters
the browser bundle, so server imports in it need no stubbing (unlike script
imports, which keep their identity-stub treatment).

**Capability row** (v1, all located errors):
- `Stator.props<P>()` — **rejected**. Island props stay typed from
  `static attrs` + the open hydrate tail (`statorPropsType` keys on the
  absence of a props declaration; a fence one would collide with that
  contract). Relaxing later is additive.
- `Stator.reads` — **rejected**, as for components (route-only). Machine
  instances still arrive as props; the [[ambient-by-def-machine-reads-with-a-typed-requirement-channel]]
  design is the future door, and this feature composes with it rather than
  preempting it.
- `Stator.request` / `Stator.response` — **rejected**, as for components.
- Imports, types, plain statements — allowed. This is the point: DB
  queries, secrets, env, computed constants.

**Scope and collisions**: template expressions resolve against fence
bindings AND `use()` fields (client wiring detection keys on the use-field
set). A fence binding and a `use()` field sharing a name is ambiguous by
construction → **located compile error on the collision**, not a precedence
rule.

**What the fence enables in the shell**: everything a component render can
do — including `read()` over a machine instance that arrived via props, and
plain values from the fence. Live server reads keep their wire-patched
bindings; nothing about the recompute path changes.

**Execution semantics to document verbatim**: the fence runs per shell
render, per use-site — one island placed three times runs its fence three
times, and an arm re-render containing the island re-runs it. Identical to
server components; say so in the docs and move on.

## LSP lockstep (co-equal build item)

`virtual-code`'s client branch must type the template against fence
bindings (today even script-member resolution is deferred). Minimum bar for
shipping: the fence typechecks as hoisted code in the client virtual file's
server-scope region, the collision error surfaces in-editor, and the
`stator-vscode` minor ships in the same release window (the standing
lockstep lesson). Extend the dts ≡ virtual-code seam test with fence cases.

## Semver

Minor (2.1). The 2.0.1 error made every affected input a compile error, so
this is grammar gaining meaning — no accepted-input behavior changes.
Changesets: `@statorjs/stator` minor + `stator-vscode` minor.

## Sequencing

1. Compiler: fence processing + emission + capability row + collision
   error, with tests (compile output, render e2e in happy-dom, diagnostics).
2. LSP: virtual-code fence scope + seam-test extension.
3. Docs: the-stator-file anatomy (three regions, two worlds),
   client-components guide (retire the constants-as-props workaround),
   registration paper-cut #3 closed with a pointer here.
4. The screenshot: retake with a real fence — the marketing one-file story
   becomes compilable truth.

## Open Questions

- Does the 2.0.1 error message grow a "since 2.1: …" pointer once this
  ships, or simply invert into the capability-row errors?
  **Resolved (2026-08-11): inverted.** The blanket error is gone; what
  remains are the capability-row errors, each of which explains the model
  at the point of misuse.
- Fence + `<style>` ordering constraints in `splitStator` — believed
  order-independent already; verify with a test rather than assuming.
  **Resolved (2026-08-11): order-independent, pinned by a test**
  (`compiler-island-fence.test.ts`, region ordering).
- Should `defer()` be allowed in island shells once fences make async-ish
  data patterns attractive there? (Today's answer is whatever components
  do; keep parity, don't special-case.)
