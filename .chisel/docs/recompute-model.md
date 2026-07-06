# The recompute model

Who re-diffs what, when, against which state. Four rules compose in the
patch-producing layer; each exists because a specific bug shipped without it.
This note is the contract — a change to any rule is a wire-behavior change.

## The pieces

- **RenderState** — per rendered page (or per SSE connection): the slot/attr
  bindings with `lastValue` baselines, indexed `byMachine`. Diffs are always
  computed against a RenderState's baselines, never against HTML.
- **Patch producers** — exactly three:
  1. **POST `/__events`** — synchronous with the dispatch, same runtime that
     just mutated (actors live). Patches return in the response, plus
     `committed` (did any machine transition).
  2. **Fan-out** — after any settle (POST, API route, effect completion,
     `dispatchToApp`), every open SSE connection re-diffs its own RenderState.
  3. **Initial sync** — on SSE connect, every binding force-emits its current
     value (keyed lists reset wholesale via one `html` patch).

## The rules

1. **Convergence on connect** (initial sync). A page's DOM is rendered at GET
   time; its connection's baseline at connect time. Anything that changed in
   the gap would otherwise be permanently invisible — the connect burst
   converges the DOM onto the baseline. Patches are idempotent; a fresh page
   repaints in place. *(Shipped bug: checkout stuck on "Radioing the bank"
   when the charge settled during navigation.)*

2. **Connection runtimes are read caches; the Store is truth.** Session
   mutations happen in other runtimes and reach a connection only through
   persistence — so before re-diffing a DIRECTLY-touched session machine, the
   connection REHYDRATES it from the Store. App machines need no rehydration:
   the process-global instance is the state. *(Shipped bug: fan-out diffing
   frozen connect-time actors → no patch, ever.)*

3. **Session touches are scoped to their session.** A directly-touched
   session machine re-diffs only for connections whose sessionId matches the
   dispatch's. Cross-session session-state must never leak; app-machine
   touches reach every connection (shared state is the point).

4. **Touched sets expand through the reverse-reads graph** (reads-aware
   selectors). If A's selectors read B and B changed, A's bindings re-diff
   even though A's state didn't move. Expansion-DERIVED session machines
   re-diff for EVERY connection, any session, WITHOUT rehydration — their own
   state didn't change; their dependencies did. Persistence always uses the
   un-expanded set. *(Gap: a cart's stock-ceiling verdict going stale when
   inventory moves.)*

## Invariants

- A binding's `lastValue` advances only when its patch is emitted (or
  subsumed by a scope replacement) — baselines and DOM never diverge except
  inside rule 1's window, which rule 1 closes.
- Expansion is static and transitive over declared `reads:`; nothing is
  tracked at runtime. (Signals remain rejected.)
- Keyed lists never receive positional ops from a producer that can't know
  the DOM's row set — hence initial sync resets them wholesale.
- All rules run under the session lock (or against live app instances);
  selectors and guards see commit-point-consistent state. The sync render
  contract is what makes this sufficient.
