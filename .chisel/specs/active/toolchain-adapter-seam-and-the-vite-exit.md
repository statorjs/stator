---
title: Toolchain adapter seam and the Vite exit
status: draft
created: 2026-08-15
updated: 2026-08-15
area: tooling
---

## What and Why

Stator's dev/build toolchain has a **two-layer split**: `stator dev` runs `tsx`
(or the new CLI loader) as the OUTER process, which embeds Vite as an INNER
middleware to compile `.stator`/routes. The split is a *module-graph fence*, not
a directory: a file imported from both sides gets two transformed instances with
divergent state — the documented `dispatchToApp` dual-instance trap, generalized.
Production is already single-domain (plain TS, no server-side Vite; Vite only
bundles client islands). So it's **dev** that is dual-domain.

Two concrete pains trace to the fence: no `.env` story (server secrets have no
uniform home across the tsx/Vite boundary), and a reload gap (a `tsx`-side restart
fires no browser reload, so a changed DOM↔slot-ID contract silently breaks
patches). And the deeper structural issue: you can't tell which side of the fence
a file is on without tracing its import path.

This spec records the decision to **exit Vite** and the disciplined path there —
an adapter seam that keeps the core toolchain-agnostic, a phased migration
(D → E), and the release sequencing that carries it. Full reasoning trail
(options A–E, buy-vs-build, divergence roots) lives in the working memory
`project_dev_tsx_vite_reload_gap`; this is the durable in-repo record.

## Success Criteria

- The core (`compile()`, Hono server, wire, scoped CSS) imports **nothing** from
  Vite — proven by a seam so an esbuild adapter could feed the same core the same
  inputs/outputs.
- The dev-server fence is gone: the server runs in dev exactly as in prod (native
  TS, no `ssrLoadModule`), so no dual-instance class and zero server dev/prod
  divergence.
- Raw-TS server packaging is kept (a 1.0 decision): `.stator` compiles to
  inspectable `.stator.ts`; validation (`stator check`) is decoupled from
  compilation.
- The Vite dependency is removable as a **one-impl swap** (island bundling
  Vite→esbuild), gated on evidence, not a rewrite.

## Constraints

- **Sole-maintainer robustness.** The one real counter to owning the pipeline is
  the dev-server long-tail (paths/symlinks/monorepos/sourcemaps/watch). It is
  materially smaller now: Node does native TS strip (unflagged 23.6, LTS 24) +
  native watch, and Stator's **server-canonical, no-HMR** shape means the dev loop
  is recompile→hard-reload, not incremental HMR. Owned surface = compiler + thin
  glue (CLI, loader hook, watch loop); heavy lifting stays Node's + esbuild's.
- **Non-breaking to app code.** The end state changes the dev/build ENTRY +
  scaffold, not app source. Ships via major-cutover-pairing.
- **Evidence-gated endpoint.** E (drop Vite) is committed only after Spike 1
  (below) shows esbuild island bundling is acceptable.

## Approach

### The options frame (A–E), and why D→E

- **A** status quo — tsx-outer dev + plain-TS prod. The fence bugs.
- **B** Vite-*outer* dev — fence gone, but moves the server *into* Vite (wrong
  direction for an exit) and keeps a dev/prod execution difference.
- **C** full Vite dev+prod — one compile path, parity, but **loses raw-TS** and
  makes Vite load-bearing in prod. Rejected (raw-TS is a 1.0 decision).
- **D** don't run the server through Vite at all — dev compiles `.stator` → the
  real `.stator.ts`, runs it under native/tsx *exactly like prod*; Stator owns the
  watch→compile→reload loop; **Vite only bundles islands**. Fence gone, zero server
  divergence, raw-TS kept. "E minus the last step."
- **E** drop Vite entirely — esbuild bundles islands too. The whole
  fence/divergence/dual-instance class dissolves; one toolchain; lighter deps.
  Most Stator-aligned (Vite optimizes for the client-heavy, shared-module-graph,
  HMR world Stator's architecture avoids).

**Decision: endpoint E, reached via D.** B is skipped — it points *into* Vite.
D is the concrete next step (delivers the fence fix + raw-TS + dev==prod now) and
is a strict prefix of E; the only remaining step is swapping the island bundler.

### The adapter seam (what makes the endpoint a swap, not a fork)

Define a toolchain-adapter interface — `compileAndServe` / `bundleIslands` /
`emitProd` — with Vite as impl #1 and esbuild as impl #2. The core never imports
Vite; "lean into Vite" would only ever mean *deepen the adapter*, never couple the
core. Success test: an esbuild adapter later feeds the same core identical
inputs/outputs. Isolating island bundling behind `bundleIslands` is what lets D
ship with a Vite island-bundler and E swap it in one place.

### Two decision locks (not one gate)

- **Lock 1 — the seam.** Committed at the *start* of the dev-pipeline work.
  Endpoint-agnostic; built identically whether islands end up Vite or esbuild.
- **Lock 2 — drop Vite (E).** Committed at the *tail* of the dev-pipeline work,
  at the D→E step. Deferrable without penalty — the seam makes it a one-impl swap,
  and deferring only means carrying the Vite *bundler* dep a little longer (the
  fence, two-compile-paths, and dev/prod server divergence all already died in D).

So the toolchain choice never blocks the *start* of the pipeline work — only
Spike 1 evidence must precede shaping the seam.

### Deciding spike (runnable now — independent of config/middleware work)

- **Spike 1 (do first):** bundle a real multi-island example with esbuild
  `splitting: true`; compare total + shared-chunk bytes against the current Vite
  build (does the runtime dedupe across islands, or duplicate per island?).
- **Spike 2 (only if needed):** prototype a robust esbuild
  watch→compile→native-reload+serve loop for Stator's forgiving (no-HMR) shape.

Gating metric = **seam cleanliness + acceptable island bundles**, not the endpoint
label.

### The two targeted fixes (symptom-level, complementary to D)

Independent of the re-architecture, and already scoped:
- **`.env`:** `createDevApp` / `createApp` load `.env` → `process.env` themselves
  (server secrets belong in `process.env` — the only home uniform across tsx/Vite
  AND dev/prod; `import.meta.env` is Vite-transform-time and absent in prod). This
  is the env feature (2.4).
- **reload:** a build-id the client checks on SSE (re)connect; mismatch → hard
  reload. Reuses the wire's version-locked-runtime concept. This is the version
  feature (2.5).

## Release sequencing (2.2 → 2.6)

One story per minor; middleware+security co-cut so the middleware API is validated
by its first consumer before it freezes.

1. **2.2 — App config + CLI.** `stator.config.ts` (nested shape — see
   [[config-api-and-the-extensibility-boundary]]) + `stator dev/start/build/check`.
   This CLI *is* Phase 0 of the adapter seam (the user-facing toolchain seam;
   `stator build` runs `check` first, killing the silent-prod-break class). Already
   built on `feat/stator-cli`.
2. **2.3 — Security & middleware round.** A multi-PR release, one capability per
   PR, all into 2.3.0:
   - **PR A** *(merged)* — cross-site guard + `trustedOrigins` + strict posture.
   - **PR B** *(merged)* — the `middleware.ts` seam (`defineMiddleware`/
     `dangerouslyDefineMiddleware`, discovery, ordering, `stator(c)`, raw-Hono
     break-glass) + `cors()` / `securityHeaders()` + `origin`/`host`/`cors` config.
   - **PR C** *(next)* — session **identity primitives**: claims, middleware
     session-lifecycle ops, establish-once session + double-create fix, thin cookie
     surface. Validated by upgrading the `with-auth` starter. See
     [[session-identity-and-auth-primitives]].
   - **PR D** *(shipped, reshaped)* — the explicit **`serverOnly` event declaration**:
     a machine lists event types no client may dispatch; `/__events` rejects them with
     403 (dev **and** prod — the declaration is explicit, so no false positives and no
     dev/prod divergence). Closes the forged-completion hazard cheaply, with no compiler
     analysis. Dogfooded on `apps/store` (cart charge completions) + a
     "Server-only events" recipe. The originally-proposed **compiler-derived
     client-dispatch allowlist** was cut from 2.3 and **re-slotted to after the
     pipeline release (now 2.6)** (see below): it needs the owned build pipeline (its
     output is a build artifact) and the introspection-manifest substrate, and its
     prod-only-403 failure mode fights the dev==prod goal the pipeline work chases.
     `serverOnly` usage becomes the evidence for whether the automatic version ever
     earns the compiler lift. Design: `.chisel/docs/client-dispatch-allowlist.md`.
3. **2.4 — Typed env + `.env` loading** (the loader is the real gap; direction
   pre-decided). Carries the auth-primitive **part 2**: **signed cookies** (= sealed
   state) via the env secret — see [[session-identity-and-auth-primitives]]. The
   `.env` loader is one of the two targeted fixes below — independent of the Vite exit,
   so it ships first.
4. **2.5 — Deploy-aware clients (version/build-id)** (reload handshake). The second
   targeted fix — also independent of the Vite exit.
5. **2.6 — Own the dev/build pipeline (the Vite exit).** Adapter-seam interface +
   Option D (server native, fence dead, raw-TS kept), Vite behind `bundleIslands`.
   Spike 1 gates D→E *within* this release: acceptable → swap islands to esbuild and
   drop the Vite dep (E); marginal → ship D, defer the swap. Either way the fence +
   raw-TS wins are banked.

**Reorder rationale (2026-08-17):** the Vite exit was moved from 2.4 to *last*. Its
two symptom-level pains — no `.env` story, the reload gap — have targeted fixes that
are **independent of the re-architecture** (see below), so env (now 2.4) and build-id
reload (now 2.5) ship as quick non-breaking wins *before* the larger, spike-gated
pipeline work. This continues the 2.3 auth-primitive thread (signed cookies) sooner
and de-risks the schedule: the Vite decision no longer blocks user-visible features.
Trade-off accepted: the two fixes land on today's two-watcher setup rather than the
owned loop, so they're band-aids the pipeline release later subsumes — cheap and
worth it for the earlier delivery.

**Post-pipeline (2.6), evidence-gated — compiler-derived client-dispatch allowlist.**
The automatic version of PR D: the compiler enumerates every client dispatch site
(template `on:` + island `dispatch`), derives the per-machine client-dispatch set,
and enforces it at `/__events`. Deferred to *after* the pipeline is owned so its build
artifact rides the owned build + the introspection-manifest substrate, and ideally
surfaces first as a **dev-visible `stator check` lint** (sound tier) rather than a
silent prod gate — no dev/prod divergence. Promotion bar: the manifest substrate
landing *and* a justification beyond the manual `serverOnly` flag (real `serverOnly`
usage that's painful to maintain by hand, or a non-security manifest consumer). Design:
`.chisel/docs/client-dispatch-allowlist.md`.

env (2.4) and version (2.5) are the two targeted fixes — independent of each other and
of the Vite exit (2.6), which is why they now ship ahead of it.

## Alternatives Considered

- **Buy Vite (stay), keep E reachable** — the prior lean (2026-08-14), driven by
  sole-maintainer robustness fear. Superseded by the current decision to exit,
  because platform maturity (Node native TS + watch) and Stator's no-HMR shape
  shrink the owned surface that motivated "buy."
- **B (Vite-outer)** — kills the fence but deepens Vite in the server; wrong
  direction for an exit. Rejected as a destination; not even used as a phase (D is
  the phase).
- **C (full Vite)** — parity at the cost of raw-TS packaging. Rejected.

## Open Questions

- Spike 1 result: is esbuild `splitting` shared-chunk output acceptable for real
  multi-island apps, or does the runtime duplicate per island?
- Exact shape of the watch loop / error-overlay Stator owns in D (reuses existing
  compile-error code frames).
- `machineStub` (island machine-import stubbing) as an esbuild `onResolve`/
  `onLoad` plugin; route→island manifest as an esbuild metafile.
- Whether `tsx` is dropped for Node-native TS at the same time or stays a swappable
  adapter until the min-Node floor rises.

## Implementation Notes

- Phase 0 (CLI + `stator check`) built on `feat/stator-cli` (uncommitted at time of
  writing); it doubles as the user-facing adapter seam.
- Cross-links: [[config-api-and-the-extensibility-boundary]] (2.2 config shape and
  the config/behavior rule), and the memory `project_dev_tsx_vite_reload_gap` (the
  A–E reasoning trail).
