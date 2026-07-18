---
title: Ambient by-def machine reads with a typed requirement channel
status: draft
created: 2026-07-18
updated: 2026-07-18
area: runtime
---

## What and Why

Today `Stator.reads([...])` is route-only (`compile.ts:361` throws
`Stator.reads() is only available in a route page. A component receives
machines as props.`). A component gets its state by receiving the machine
*handle* as a prop and doing its own `read(handle, …)`. That's the right
default — see [why route-only is correct](#alternatives-considered) — but it
means **state is prop-drilled through the whole component tree**. In the
weather example, every tile needs `weather={weather}`, threaded through
`<Panel>` down to `<UvTile>`. At scale this is real DX friction, and the
failure mode (forgetting the prop) is only caught at runtime.

**The insight:** the "provider" already exists. A route loads its whole machine
graph into a request-scoped context (`Stator.reads([M])` compiles to
`[__ctx[M.name]]`, `compile.ts:372`) that is **ambient across the entire
synchronous render pass** — every nested component already can reach it. The
handle we drill is redundant. And the runtime already resolves machines *by
name*, not by handle identity: on the live path `read()` calls
`state.currentRuntime.proxyFor(def.name)` (`read.ts:45`); the passed handle is
used only to recover `def.name` via `defForProxy`. The handle is vestigial.

**The proposal, in two layers:**

1. **Ambient by-def reads.** A component addresses a machine by its imported
   *definition*, resolved from the ambient context: `read(WeatherMachine, w =>
   w.panelForId(id).uv)`. No prop, no handle. This mirrors client islands,
   which already dispatch by def (`dispatch(WeatherMachine, event)`) — unifying
   the model: **machines are always addressed by their imported def.**

2. **A typed requirement channel (inversion of control).** A component
   *declares* the context it depends on simply by reading it, and that
   requirement is carried in the *type* and **enforced up the tree by
   TypeScript**: anything that renders the component must make that machine
   available, or propagate the requirement upward, until a route discharges it
   via `Stator.reads`. A missing dependency becomes a compile error at the
   boundary — not a runtime throw.

This is the effect-system environment/requirements channel (ZIO/Effect-TS `R`,
the Reader monad, compile-time DI) brought to a server-rendered component tree
— a combination that is, as far as we know, novel.

Surfaced by the weather-example refactor; cross-referenced from the example's
`FINDINGS.md` #8.

## Success Criteria

- A component reads shared state with **zero state prop-drilling** — only
  genuinely-local params (`placeId`: "which item am I") remain props.
- `read(Machine, sel)` gives **full type inference** of the selector view with
  no annotations (`w` is `InstanceOf<typeof Machine>`), because inference flows
  from a concrete def value, not a reverse-mapped conditional.
- **The route stays the single authority** on what is loaded (lifecycle +
  capability surface unchanged). Reads still declare the load graph.
- A component that reads a machine **no ancestor route provides is a compile
  error, in-editor, at the offending boundary** — replacing today's runtime
  `CompileError`.
- Read and dispatch are **symmetric**: both address machines by imported def;
  the handle (`Stator.reads` destructure) is no longer needed at call sites.

## Constraints

- **Route-declared loading must remain.** Machines rehydrate from a store
  asynchronously; that must complete before the synchronous render. Reads
  therefore still declare the load graph at the request entry point. This
  feature changes *access ergonomics*, not *when/where loading is declared*.
- **Pure TS cannot union a phantom param across JSX children** — a template's
  children collapse to opaque fragments. The compiler must emit the template
  combinators (`each`/`when`/component invocation) and component signatures
  already threaded with the requirement channel. This is plumbing Stator's
  lowering already owns; it is not developer surface.
- **Backward compatibility.** The current `read(handle, sel)` form (route with
  `Stator.reads` destructure) should keep working during migration; `read(def,
  sel)` is additive.
- **Per-connection isolation.** Resolution must use the current render state's
  context so SSE recompute stays per-connection (the by-name resolution in
  `read.ts:45` already behaves this way).
- Out of scope: changing the machine *loading* mechanism, auth/capability
  enforcement beyond "is it loaded", and client-island dispatch (already by-def).

## Approach

### Layer 1 — by-def resolution
Add an overload `read<D extends AnyMachineDef, R>(def: D, sel: (v: InstanceOf<D>)
=> R): ReadResult<R>`. `D` infers directly from the def value (invertible,
unlike inferring from `InstanceOf<TDef>`). Runtime: resolve the handle from the
current render state's context by `def.name` (the same path `read.ts:45`
already uses on recompute), dropping the `defForProxy` handle→def indirection.
`Stator.reads([...])` at the route becomes a pure *load declaration* (it need
not bind handles).

### Layer 2 — the requirement channel
Give the rendered fragment a phantom requirement parameter, `Fragment<R>`:

- `read(WeatherMachine, …)` produces `Fragment<Requires<WeatherMachine>>`.
- The compiler-emitted combinators **union** children's `R`: a component's
  fragment type is `Fragment<⋃ children R>`. So a `<Panel>` that renders
  `<UvTile>` without providing weather is itself
  `Fragment<Requires<WeatherMachine>>` — the requirement propagated by the type,
  with no author action.
- A route **discharges**: `Stator.reads([WeatherMachine, …])` yields a
  `Provides<…>` that subtracts those machines from `R`, and the route body is
  constrained to `Fragment<never>` (all requirements satisfied).
- An undischarged requirement is `Fragment<Requires<WeatherMachine>>` failing to
  be assignable to `Fragment<never>` — a plain type error. With a branded
  `Requires<M>` carrying the machine name, the diagnostic can name the missing
  machine and point at the `<Component/>` call or the route's `reads`.

`Provides<M> = { readonly [K in M['name']]: InstanceOf<M> }`; multiple provides
intersect; a component requiring several intersects its `Requires`; satisfaction
is structural subtyping, which TS handles well. The **enforcement is TS-native**
(assignability of the channel); only the *threading* is compiler-generated.

### Error UX / migration
- Today: read an unloaded machine → runtime `CompileError`. After: an in-editor
  type error at the boundary, naming the machine.
- Migrate incrementally: keep `read(handle)`; introduce `read(def)`; move the
  weather example's `weather={weather} placeId` tiles to `placeId`-only +
  `read(WeatherMachine, …)` as the reference implementation.

## Alternatives Considered

- **Prop-drill the handle (today's contract).** Correct and explicit, but drills
  *state* through every layer; missing prop caught only at runtime. This is what
  the feature removes for shared state (local params stay props).
- **Why route-only reads is the right default (kept).** Loading is a setup-phase
  concern (async store rehydration before a sync render); the route is the
  capability surface (reads server-pin machines and gate request access);
  data-down/container-presentational keeps components reusable. The feature keeps
  all of this — it changes access, not declaration.
- **React-style context providers.** A `<Provider value={weather}>` + `use()`.
  Inferior: needs a provider component and wrapping; a missing provider is a
  runtime `undefined`/throw; `createContext<T>()` typing is bolt-on with a
  nullable default. The requirement channel needs no provider (discharge is the
  route's `reads`) and is compile-checked.
- **Compiler static subset-check (earlier idea).** A separate build pass
  verifying each route's reads ⊇ its components' reads. Works, but enforcement
  lives outside the type system (not in-editor, not compositional). The
  requirement channel subsumes it and surfaces at the exact call site.
- **Automatic prop-forwarding** (compiler drills a marked prop through
  intermediates). Hacky; the ambient channel removes the drilling entirely.

## Open Questions

- **API surface / naming.** `read(Machine, sel)` reused via overload, or a
  distinct `use(Machine)` that returns the handle for multiple reads? Symmetry
  target is `read`/`dispatch` both by def.
- **Diagnostic quality.** How reliably can the `Fragment<never>` assignment
  failure be shaped (branded `Requires<M>`) so the message *names* the missing
  machine and maps to the `<Component/>` usage via the virtual-code source map?
- **Isolation testing.** Testing a component standalone now needs a harness that
  seeds an ambient ctx with the machine (vs. passing props). Provide a
  `renderWithContext([...])` test helper.
- **Dynamic composition.** Requirements over conditional/dynamic children are
  over-approximated (if a route *might* render C it must provide C's machines).
  Confirm this is acceptable and matches the combinator typing.
- **Relationship to FINDINGS #8.** By-def inference flows from a concrete value
  and sidesteps the reported LSP red; confirm once #8's exact error is captured.

## Implementation Notes

<!-- Updated during/after implementation. -->
