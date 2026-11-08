---
title: 'Per-record child machines: composing a collection of workflows'
status: draft
created: 2026-08-01
updated: 2026-11-08
area: runtime
---

## What and Why

The recurring hard shape is a **collection of per-record workflows** — an admin table, a queue, a dashboard: N records, each with its own little state machine
(idle → committing → settled | conflict | failed, with retries), sitting under a
machine-wide axis (loading / ready). Building the `stockroom` example (an editable inventory admin) the natural, flat way surfaced **three independent frictions that all point at the same missing primitive: a per-record workflow should be its own machine, and a machine should be able to own a keyed collection of them.**

This spec is the motivation record for that direction. The fuller design exploration (intra-machine parallel regions vs. child/family machines, and the "reusable generic machine" idea) lives in the parallel-regions RFC + maintainer response; the decision between those shapes is still open. What is settled is the *problem*, from three angles:

### Evidence 1 — correctness: completions strand (the effects angle)

A flat collection machine puts freshness (`loading`/`ready`) in its chart and pushes the per-record save workflow into `context` (`ctx.saves: Record<id, phase>`). A per-record save's completion (`SAVE_OK`/`CONFLICT`/`FAILED`) can only be handled where it is declared — `ready` — so a `REFRESH` that moves the machine to `loading` mid-save drops the completion and strands that row in `saving` forever. **Resolved for the drop** by machine-level `on:` (shipped) — handlers that apply in any state. But that fixes the *drop*, not the fact that the workflow is a phase string in a side map rather than a chart. Runnable repro: `examples/stockroom/tests/inventory.test.ts`.

### Evidence 2 — audit surface: the workflow is invisible in the chart

Stator sells "read the chart to audit every state, event, guard." The per-record workflow — where the interesting states (conflict, failed) and their retries live — is not in the chart; it is reconstructable only by reading a context map mutated by action bodies. In one row this shows as an asymmetry: the live "on hand" cell is a clean item read `read(row, r => r.onHand)`, but the save **status** cell can't be (the phase isn't a field of `row`, it's in `ctx.saves`), so it's a machine read keyed by id. The interesting per-record state is neither in the chart nor on the record.

### Evidence 3 — composition / DX: item reads don't cross a component boundary

Decomposing the table into per-row child components — `each(read(m, i => i.rows), (row) => <StockRow row={row} … />)` — was built and measured. **Composition itself works**: a keyed `each` whose body is a component renders one root element per item under the row's key scope, and its bindings update reactively. **But item reads don't cross the boundary**: in `<StockRow>`, `row` is a prop, not the each item param, so `read(row, …)` isn't an item read — it lowers as a machine read and throws. The child's live cells fall back to find-by-id machine reads (`read(m, i => i.rows.find(r => r.id === id)?.field)`) — O(n) per cell, O(n²) per table. Static fields (`sku`, `name`) pass cleanly as props; only the live fields pay the tax.

That find-by-id is the **symptom of the row not having its own machine**: the child reaches back into the parent and re-locates itself by id on every cell precisely because the row is a slice of `ctx.rows`, not an addressable unit. With a per-record child machine, `<StockRow>` would read *its own* state (`read(rowMachine, m => m.onHand)`) — clean AND composable, no find-by-id, no O(n²). Item-value bindings are the inline-only stopgap that works until the list is decomposed into components; see the "inline-only" note in [`per-row-item-value-bindings-in-each.md`](../shipped/per-row-item-value-bindings-in-each.md).

### Evidence 4 — authoring DX: reusable machines are how you shrink a large `defineMachine`

Separately, a machine-authoring-DX pass (riffed 2026-08-01) asked "what higher-level abstraction — e.g. JSX for state machines — would cut `defineMachine` boilerplate?" and landed back here. The bulk of a large machine (188 lines for stockroom) is not domain logic; it is **recurring workflow shapes written inline** — an async op is always idle→committing→ok/conflict/error, a load is always loading→ready+completion. A *syntax* layer (structural JSX) makes all of it terser-but-still-inline (a modest win, mostly covered by extracting inline callbacks to named functions). The real leverage is **raising the abstraction**: a small library of **reusable generic machines** (`AsyncUpdate`, `Load`, `Poll`) composed as children, so the host collapses to its own domain state + the composition, and the recurring clusters move out into named, reusable units. That reusable primitive is the same one this spec needs — the authoring-DX thread resolves *into* this one. (Left open there: "magic strings" — typed name accessors like `M.states.ready` / `M.events.SAVE` derived from the def, a separate small ergonomic item that doesn't need child machines.)

### Evidence 5 — the second collection example arrived: three machines in IndiePub (2026-11-08)

The "decision deferred to a second collection example" condition is met, three times over, in `@indiepub/stator` running tonysull.co in production. `OutboxMachine` (one webmention or silo copy per post × target), `MentionsMachine` (one verification per inbound mention) and the backfeed all have the same shape: a `Record<key, workflow>` in context, completions in machine-level `on:` so nothing strands, an entry effect that rebuilds the window from SQLite and re-drives interrupted work. The outbox says the limit in its own doc comment: *interactive retries stay owner-triggered — per-entry backoff wants per-record `after`, which flat machines don't have*. A failed send to a flaky endpoint today waits for the owner to press retry; with a per-send machine it is a `failed` state with `after: [{ delay: (ctx) => backoff(ctx.attempts), send: 'RETRY' }]`, and the admin's outbox list renders one row component per send reading that send's own state. That is the validation target for this spec.

## Approach (proposed 2026-11-08)

**Families, not regions.** A family is one machine definition whose instances are addressed by a key. Every instance is a full machine with its own chart, context, effects, `after` timers and snapshot; the definition is written once. Parallel regions inside one actor keep the per-record workflow in a single context and fix Evidence 1 and 2 at best; only separate instances fix Evidence 3 (a row component reads its own machine) and Evidence 5 (per-record `after`). The parallel-regions RFC's other shape is set aside.

**Why it fits the engine.** Every registry Stator keeps is keyed by machine name today: `after` timers by `scope · name · state` (`server/timers.ts`), in-flight effects by `scope + machineName` (`server/effects.ts`), render bindings in `RenderState.byMachine`, session actors and app instances by name, persistence blobs by `(scope, name)`, subscriptions by source name, and the code hash per machine. A family generalises the address from `name` to an *instance address* `name[key]`; each registry keeps its shape and widens its key. A plain machine is a family of one with no key, so nothing existing changes.

### The surface

```ts
// machines/outbox-send.ts
export default defineMachine({
  name: 'OutboxSend',
  lifecycle: 'app',
  // The instance key, read from any event addressed to the family.
  family: { key: (ev) => ev.key, creates: ['QUEUE'] },
  events: {} as SendEvents,
  context: { postSlug: '', target: '', attempts: 0 } as SendContext,
  seed: (ev) => ({ context: { postSlug: ev.postSlug, target: ev.target } }),
  initial: 'sending',
  states: {
    sending: { entry: deliver, on: { SENT: 'sent', NO_ENDPOINT: 'gone', SEND_FAILED: 'failed' } },
    failed: {
      after: [{ delay: (ctx) => backoff(ctx.attempts), send: 'RETRY' }],
      on: { RETRY: { when: (ctx) => ctx.attempts < 6, to: 'sending', do: (ctx) => { ctx.attempts++ } } },
    },
    sent: { final: true },
    gone: { final: true },
  },
  selectors: { status: (ctx, state) => state, target: (ctx) => ctx.target },
})
```

- `family.key(event)` names the instance an event is for. Events reach a family the same ways they reach any machine (`subscribes`, `dispatchToApp`, route `dispatch`); the key routes them. An effect's completion returns to the instance that started it, because the effect registry records the instance address.
- `family.creates` lists the events that may materialise a new instance; `seed(event)` gives it its first context. Any other event addressed to an unknown key is dropped and logged, the way an event for an expired session is: a typo'd key never spawns a zombie.
- A `final: true` state passivates the instance: its timers and effects are gone, its snapshot is deleted, and it leaves the family's key set. What the record means afterwards lives in the app's own storage (the outbox row says `sent`), which is the "machines are working state" position the hydration policy already takes.
- Templates read a family through the same declaration as any machine. `Stator.reads([OutboxSend])` gives a family proxy: `sends.keys` and `sends.of(key)` (an instance proxy). `each(read(sends, (f) => f.keys), (key) => <SendRow send={sends.of(key)} />)` renders one component per instance, and inside it `read(send, (s) => s.status)` binds to that instance's address, so a change patches one row and the component needs no find-by-id. Family-wide reads (`read(sends, (f) => f.count((s) => s.status === 'failed'))`) recompute when membership or any instance changes; O(n) per change, measured before it is optimised.

### Lifecycle and the rebuild

App families start empty at boot like any app machine. The IndiePub machines rebuild from SQLite in an entry effect today; a family gets the same hook at family scope, `family.restore: () => Array<{ key, event }>`, run once at boot, which re-materialises the instances whose rows are unfinished by sending each its creating event. That is today's re-drive, moved from a loop in one machine's entry effect to the family. `persist: true` families store one blob per instance keyed by the instance address and reconcile each against the definition's code hash, so a release that changes `OutboxSend` resets every send, exactly as it resets a plain machine.

### Session families and the rest

All three IndiePub machines, and `stockroom`, are app machines; app families come first. Session families (a per-session collection, e.g. a multi-step form per draft) reuse the same address in the session scope and are a second stage. Out of scope: nested families, a family addressing another family's instances by key, parent-owned spawning (`spawn(ctx, Child, key)`), and the reusable generic-machine library (`AsyncUpdate`, `Load`), which families make possible but which waits for its own evidence.

## Success Criteria

A machine definition can declare a keyed family such that: (a) an instance's effect completion and `after` timer route to that instance and cannot strand; (b) each record's workflow is a real chart, visible in `describeMachine` and the inspector as one machine with its instances; (c) a per-row component reads its own instance, so a list decomposes into `<Row>` components without find-by-id and a change patches one row; (d) `OutboxMachine` in `@indiepub/stator` becomes an `OutboxSend` family with automatic per-send backoff, and tonysull.co's admin outbox renders one row component per send. Non-breaking: a machine without `family` is unchanged.

## Plan

1. **Spike: instance addresses in the registries.** Widen timers, effects, the store's app instances, render bindings and fan-out from `name` to `name[key]` behind an internal API; drive it with a fixture family (app lifecycle, unpersisted, an `after` per instance, effect completions) and the existing suite unchanged. Exit: the fixture's per-instance timers and completions route correctly, `recompute` patches one instance's slot, and the 900 framework tests pass untouched.
2. **The public surface.** `family: { key, creates }`, `seed(event)`, `final` passivation, `family.restore`, the family proxy in reads (`keys`, `of`, aggregate reads), `describeMachine` and the inspector showing a family. Docs: a "collections of workflows" guide replacing the machine-level-`on:` workaround as the recommended shape.
3. **Validation in IndiePub.** `OutboxSend` replaces `OutboxMachine` (per-send backoff via `after`), then `MentionVerification` replaces the verifying map; tonysull.co's outbox list becomes per-send rows. `examples/stockroom` moves to a row family as the framework's own proof.
4. **Persistence and session families**, if the evidence asks.

Target: a 3.x minor, or a late 3.0 beta if stage 2 lands before the release; nothing here depends on the 3.0 cutovers.

## Open Questions

- **Name.** `family` (this draft), `keyed`, or `collection`.
- **Materialisation.** Implicit on a `creates` event (this draft) versus an explicit `CREATE`-style event the app dispatches; the draft keeps it declarative and refuses unknown keys otherwise.
- **Passivation timing.** Drop on reaching a `final` state immediately (this draft), or keep finished instances for a window so the UI can show "sent" before the row disappears. The outbox wants the latter in the admin; a `retain` duration on the family is the likely answer.
- **Aggregate reads at scale.** Recomputing a family-wide read on every instance change is O(n); fine for hundreds, to be measured before thousands.
- **Keys in `subscribes`.** Whether a subscription into a family must name its key function explicitly or always uses the family's own `key`.

## Implementation Notes

Not started; the approach above is the 2026-11-08 proposal, awaiting decisions. Originally a motivation/direction record. Evidence: `examples/stockroom` (the inventory admin) and its machine test. Related: machine-level `on:` (shipped, Evidence 1's drop fix), per-row item-value bindings (Evidence 3's inline stopgap), the parallel-regions RFC (design exploration).

**Anticipated second evidence point (2026-09-10):** the personal-site IndiePub-on-Stator port (dogfooding thread) will need per-record retry/backoff timers for at least two independent record collections — outbox entries (automatic webmention-send retry, today owner-button-only in `examples/indie-blog`) and pending mentions (re-verification retries) — matching this spec's own "Evidence 2" occurrence in `indie-blog`'s outbox. Deliberately not started yet; held until that dogfood actually needs it, per the "decision deferred to a second collection example" framing above. Recorded here only so the connection isn't lost when that work starts.
