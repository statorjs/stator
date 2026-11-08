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

### Evidence 6 — the fleet app: families of families, and settlement per group (2026-11-08)

Tony's other production app watches a fleet of robots and raises alerts to an operations team. Each robot is a machine whose context comes from the database; each rule (written in markdown) is evaluated by its own machine per robot. On a robot state change (debounced 5 s) the robot machine updates, then every rule machine for that robot recomputes its alert from the robot's new state and its own previous evaluation; some rules wait 30 s before a condition raises, which the app does without timers: the rule records when the condition was first met, and a later robot update raises once 30 s have passed (exact timing does not matter, and robots update often). Inventory changes at runtime: a robot that comes online after boot needs its machine and its rule machines created, and a robot removed from inventory needs them removed. Scale: about 80 robots and 4 rules today, expected to reach roughly 160 robots and 12 rules, so around 2,000 rule instances. Each rule machine logs raise and clear to Elastic (async), and **only after every rule machine for that robot has settled** does the app write the robot's full alert list to Elastic and the database. The app built its own synchronisation layer to know when that moment had come.

What it adds to the requirements: two families, one addressing the other by key (`Robot[robotId]` and `RuleEvaluation[robotId/ruleId]`); one event multicast to every instance in a group (all rules of a robot); settlement grouped by that robot, so one reaction per robot rather than per change; a delayed raise that triggers its own settled reaction later; and summary writes that must not land out of order when updates overlap.

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

- `family.key(event)` names the instance an event is for, or `family.keys(event)` names several: one robot update addressed to the rule family reaches every rule instance of that robot (`keys: (ev) => rulesFor(ev.robotId).map((r) => `${ev.robotId}/${r}`)`), the fleet app's fan-out. Events reach a family the same ways they reach any machine (`subscribes`, `dispatchToApp`, route `dispatch`); the key routes them. An effect's completion returns to the instance that started it, because the effect registry records the instance address.
- `family.creates` lists the events that may create a new instance; `seed(event)` gives it its first context. Any other event addressed to an unknown key is dropped and logged, the way an event for an expired session is: a typo'd key never spawns a zombie.
- A `final: true` state **completes** the instance (see *Lifecycle terms*): its timers and effects are gone, its snapshot is deleted, and it leaves the family's key set. What the record means afterwards lives in the app's own storage (the outbox row says `sent`), which is the "machines are working state" position the hydration policy already takes.
- Templates read a family through the same declaration as any machine. `Stator.reads([OutboxSend])` gives a family proxy: `sends.keys` and `sends.of(key)` (an instance proxy). `each(read(sends, (f) => f.keys), (key) => <SendRow send={sends.of(key)} />)` renders one component per instance, and inside it `read(send, (s) => s.status)` binds to that instance's address, so a change patches one row and the component needs no find-by-id. Family-wide reads (`read(sends, (f) => f.count((s) => s.status === 'failed'))`) recompute when membership or any instance changes; O(n) per change, measured before it is optimised.

### Lifecycle terms

Two lifecycles, kept apart: whether an instance **exists**, and whether it is **resident** in memory right now. (Earlier drafts blurred them, and once used *passivation* for an instance reaching `final`; in Orleans and Akka passivation is reversible, and it is here.)

**Existence**
- **Creation**: a `creates` event for a key with no instance. `seed(event)` gives the first context and the initial state is entered for real (entry effects run, `after` timers arm). The instance gets a **generation** number. A robot coming online after boot is created by its first update, and a multicast `keys(event)` creates its rule instances in the same turn. `family.restore` at boot is creation driven by the app's storage, for rows it says are unfinished.
- **Completion**: the workflow is finished for good. Reaching a `final` state completes the instance, after an optional `retain` window. Timers are cancelled, in-flight effects are aborted through their signal and any late result is dropped, the key leaves the key set, and any snapshot is deleted. A later `creates` event for the same key creates a new incarnation with a higher generation, which keeps a slow effect from the old one out of the new one. Removal is expressed in the chart: a robot leaving inventory moves to a `final` `retired` state and emits `RETIRED`, its rule instances subscribe and move to `final`, and grouped settlement fires once more, where the app writes the cleared alert list.

**Residence**
- **Activation**: the instance is loaded into memory, with an actor and routing for its key: at creation, or by **rehydrating** a snapshot that passes the code-hash check (entry effects re-invoked and timers re-armed with elapsed credit, under the work-lifetime contract).
- **Passivation**: the instance leaves memory and its snapshot stays; the next event for its key activates it again. Only possible when the instance is **idle** (no effect in flight, no `after` timer armed), since nothing can wake a passivated instance for a timer until durable timers exist.

**Residence, later.** In the first surface every family is resident: an instance is activated at creation and kept until completion, as app machines are kept today. A future per-family option could choose `residence: 'stored'` instead (see *Surface budget*); app machines are long-lived actors now, and the outbox and the fleet at around 2,000 instances fit comfortably. `residence: 'stored'` activates an instance for each turn that addresses it and passivates it after, which is exactly how session machines already work (a transient runtime rehydrates per request, persists what changed, disposes); it suits large families of mostly idle instances, needs a store, and cannot hold an `after` timer across turns. Session machines map onto the same words: created on first use, activated and passivated every request, completed by TTL expiry or an explicit wipe.

Process shutdown is none of these: resident instances stop, snapshots survive under the hash policy, and the next boot rehydrates or restores.

### Lifecycle and the rebuild

App families start empty at boot like any app machine. The IndiePub machines rebuild from SQLite in an entry effect today; a family gets the same hook at family scope, `family.restore: () => Array<{ key, event }>`, run once at boot, which re-materialises the instances whose rows are unfinished by sending each its creating event. That is today's re-drive, moved from a loop in one machine's entry effect to the family. `persist: true` families store one blob per instance keyed by the instance address and reconcile each against the definition's code hash, so a release that changes `OutboxSend` resets every send, exactly as it resets a plain machine.

### Session families and the rest

All three IndiePub machines, and `stockroom`, are app machines; app families come first. Session families (a per-session collection, e.g. a multi-step form per draft) reuse the same address in the session scope and are a second stage. A family subscribing to another family is in scope (Evidence 6): the subscription maps the source's emit to an event, and the target family's own `key` or `keys` routes it, so `RuleEvaluation` subscribes to `Robot`'s `UPDATED` and `Robot` to `RuleEvaluation`'s settled changes, both by `robotId`. Out of scope: nested definitions (a family declared inside a machine), parent-owned spawning (`spawn(ctx, Child, key)`), and the reusable generic-machine library (`AsyncUpdate`, `Load`), which families make possible but which waits for its own evidence.

## Prior art and naming (round two, 2026-11-08)

The shape, one definition and many keyed instances that each own their state and timers, is old. How others build and name it:

| System | Term | Key and creation | Lifecycle | What it teaches |
|---|---|---|---|---|
| XState v5 | spawned **actors**, `spawnChild`, `systemId` | the parent spawns into its context and holds the ref | `stopChild`; persisted inside the parent's snapshot | Parent ownership couples the collection to one machine's snapshot; nothing routes by key, the parent forwards. The coupling this spec avoids. |
| Akka Cluster Sharding | **entities**, entity id | a message extractor reads the id from each message; the entity starts on its first message | **passivation** when idle, optional "remember entities" | `family.key(event)` is Akka's extractor. Passivation is the established word. |
| Microsoft Orleans | virtual actors, **grains** | addressed by identity, **activated** implicitly on first call | deactivated when idle, reactivated transparently | Implicit activation is safe because a grain's state is its storage, not its memory. |
| Cloudflare Durable Objects | object per id (`idFromName`) | created on first request to the id | per-object storage and **alarms**, hibernation | The closest analogue: one alarm per object is per-instance `after`. |
| Erlang/OTP | `DynamicSupervisor` + `Registry` | started explicitly, named `{:via, Registry, key}` | supervised restart | Creation is explicit; lookups by key are a separate concern. |
| Recoil / Jotai | **`atomFamily`** | `family(param)` memoises one atom per parameter | never collected unless removed (`setShouldRemove`) | "Family" reads naturally to UI developers, and its known failure is unbounded growth: removal has to be designed in. |
| MobX-State-Tree | `types.map(Model)` | a keyed map of model instances with identifiers | the map owns them | A collection of live models, not of workflows. |
| SCXML / statecharts | `<invoke>`, parallel regions | children invoked from a state | live while the state is active | Regions are the alternative this spec set aside. |

**Naming.** Three families of words exist: *actor* (XState, Akka, Orleans) names the concurrency model and would suggest message passing Stator does not have; *entity* (Akka, Redux's entity adapter) is overloaded with data rows; *family* (Recoil, Jotai) names exactly "one definition, many keyed members" and is the word UI developers already know. Proposal: the option is `family`, a member is an **instance** (the word the engine already uses, `appInstance`, `createInstanceProxy`), and its lifecycle is two pairs: **creation** and **completion** for existence, **activation** and **passivation** for residence in memory, the second pair borrowed from Orleans and Akka with its meaning intact. Jotai's lesson is taken with the word: removal is part of the design, not an afterthought.

**Creation.** Akka, Orleans and Durable Objects create implicitly on the first message to a key; Erlang and XState create explicitly. Implicit creation is safe when an instance's durable meaning lives in storage, which is Stator's position, so the draft keeps it but narrows it: only events listed in `creates` may create an instance, so a mistyped key cannot.

## Concurrency, races and settlement

### What already holds

JavaScript runs one transition at a time, and Stator already makes one input a **turn**: a dispatch sends the event inside a dispatch context, every `subscribes` cascade it triggers runs synchronously inside that same send and is collected in one `touched` set, and only after the cascade does the host persist and fan out, once (`server/app-dispatch.ts`, `withDispatchContext`). So a page never renders a half-cascaded state, and two inputs never interleave inside a transition. Families keep both properties: routing to instances happens inside the turn, and fan-out stays once per turn.

What is not covered is async. An effect's completion re-enters as a new dispatch with no link to the input that started it, and an `after` timer fires as one more. With one machine that rarely matters; with a family, one change routinely starts N effects across N instances, and there is no way to say "this change, and everything it set off, has finished".

### Races a family adds, and the rule for each

1. **Two creations for one key in one turn** (the same post queued twice). The first `creates` event creates; the second is delivered to the now-live instance as an ordinary event, and its chart decides what a second `QUEUE` means. Activation is idempotent by key, never a duplicate instance.
2. **An effect result for a completed instance.** The send finished after the instance reached `final`. Dropped and logged, never re-creates it, the same rule as an event for an expired session.
3. **An effect result for an earlier incarnation.** A key completes and is created again, and the old incarnation's slow effect completes into the new one. Every instance gets a generation number at activation, effects record it, and a completion whose generation is stale is dropped. Without this, a stale failure could mark a fresh send failed.
4. **Live events during the boot rebuild.** `family.restore` re-creates unfinished rows while requests may already be queueing new work. Events for the family wait until restore has finished, then run in arrival order; otherwise a live `QUEUE` and a restore activation for one key race on rule 1 with the wrong winner.
5. **Effects in bulk.** Restore after an outage can create 500 sends at once, each starting a fetch. A family declares `concurrency` (default unbounded, the outbox would set a handful); effects beyond the limit wait in a queue in activation order. This is a resource bound, not a correctness one, and it belongs in the definition because only the author knows the downstream.
6. **Aggregates mid-cascade.** A family-wide read (failed count) evaluated after each instance's transition would flicker through intermediate values. It is evaluated at turn end with the rest of fan-out, so it sees each turn's final state once (the glitch-free rule signal libraries enforce with batching).
7. **Overlapping changes on one instance write out of order.** Two robot updates 5 s apart each settle and each start a summary write; the first write can finish after the second and leave the older alert list stored. Two rules together prevent it: the settled reaction computes the summary from current state when it runs, never from a snapshot taken at the change, and an instance can declare `effects: 'serial'` (its effects run one at a time, in order) or `effects: 'latest'` (a new effect aborts the previous one through its signal). The outbox wants `serial`; a summary write wants `latest`.
8. **Persistence order.** For a `persist: true` family, instance snapshots are written at turn end in a batch; a crash mid-batch leaves some instances at the previous turn, which the hash and reconcile policy already tolerates because instances are working state.

Out of scope and stated so: ordering across instances (only per instance), more than one process (families are per process, like app machines today; the Redis backplane remains deferred), and a cross-instance transaction (two instances changing atomically together, beyond what one turn already gives).

### Settlement

The case from Tony's other app: one change flows downstream into several related machines, each may do async work, and only when all of it has finished should one thing happen once, as small as a single log line. That app built its own synchronisation layer for it. The prior art names the idea **settled**: TanStack Query's `onSettled`, `Promise.allSettled`, Ember's test `settled()` (run loop, timers and requests all drained), Testing Library's `waitFor`. None of the state-machine libraries above provide it for a cascade; XState offers `waitFor(actor, predicate)` on one actor, and actor systems leave it to the application.

**Proposal: settlement is a property of a change, tracked by the engine.**

- Every input opens a **turn** with an id: a route dispatch, `/__events`, `dispatchToApp`, a webhook, a boot dispatch.
- An effect started during a turn records the turn as its cause. Its completion opens a child turn of that cause. Emits and `subscribes` deliveries stay inside the turn that produced them, as now.
- A change is the tree of a turn and its child turns. It is **settled** when its last turn has finished and no effect it started, directly or transitively, is still in flight.
- `after` timers are new causes, not part of the change that armed them. Otherwise a retry backoff would hold a change open for minutes, and a machine that re-arms forever would never settle.

Two surfaces, one for code outside the charts and one inside them:

```ts
// Outside: tests, boot code, a script. Resolves once the change is settled.
const { committed, settled } = await dispatchToApp(Catalog, { type: 'REPRICE', by: 0.1 })
const summary = await settled // { instances: ['PriceRow[a]', 'PriceRow[b]', …], ms, failed: [] }
console.log(`repriced ${summary.instances.length} rows in ${summary.ms} ms`)
```

```ts
// Inside: a machine reacts once to the whole change, in its chart.
subscribes: [{ from: PriceRow, settled: true, dispatch: 'REPRICED' }]
// REPRICED arrives once per settled change that touched any PriceRow,
// with the touched keys in its payload.
```

Grouped, for the fleet app: one reaction per robot, delivered to that robot's instance.

```ts
// machines/robot.ts (a family keyed by robotId)
subscribes: [{
  from: RuleEvaluation,
  settled: true,
  groupBy: (ruleKey) => ruleKey.split('/')[0], // robotId
  dispatch: (robotId, keys) => ({ type: 'RULES_SETTLED', robotId, keys }),
}],
// Robot's family key reads ev.robotId, so RULES_SETTLED lands on Robot[robotId].
// Its effect writes the alert list, computed from the rules' current state.
```

A robot update settles once all its rule instances have transitioned and their Elastic logs have returned, and `Robot[robotId]` gets one `RULES_SETTLED`. The app's delayed raise is checked inside a later robot update, so it is part of that update's change and the same grouped settlement covers it. A rule that must raise exactly on time can use a per-instance `after` instead; that timer firing is a new change, which settles and produces one more `RULES_SETTLED` for the robot. Either way the app needs no synchronisation layer of its own.

The outside surface makes tests deterministic (no polling for "has everything caught up"); the inside one keeps the reaction in a chart, which is where policy belongs.

Two things to state plainly. First, settlement is per change: a second change touching the same instances settles on its own, so "this change is settled" is not "the family is idle". A family-level idle signal (no in-flight work at all) is a separate, simpler notion and may be what some cases want; it is listed as an open question. Second, a change can fail to settle if an effect never returns; effects already take an abort signal, and `settled` takes a timeout that rejects with the instances still busy, so a stuck send is named rather than waited on forever.

Settlement is not family-specific. Plain machines cascading through `subscribes` into effects have the same gap, and the turn and cause tracking lives in the dispatch path every machine shares. It is specified here because families are where the gap becomes routine, and it can ship before families as its own feature.

## Surface budget (2026-11-08, Tony: keep it learnable)

The rest of this spec explores widely; this section decides what ships. The test is whether a developer new to Stator can learn it in one sentence and model with it the same day: **a family is a machine with a key.** Everything else waits for evidence, the rule that removed `bind:` and has kept primitives honest since.

**Core** (stage 2):
- `family: { key, creates }`: which instance an event is for, and which events may create one. `seed(event)` gives a new instance its first context.
- A `final` state completes an instance.
- `family.restore` re-creates unfinished instances from the app's storage at boot.
- Reads: a family proxy with `keys` and `of(key)`, so a row component reads its own instance.
- User docs teach two lifecycle words, **creation** and **completion**. Turns, causes and generation numbers are engine internals and never appear in the guide.

**Settlement** (stage 0, before families, useful to plain machines): the `settled` promise on dispatch results, and `subscribes: [{ settled: true, groupBy }]`. `groupBy` is in because the fleet app's per-robot write is the motivating case.

**Extensions, each held until a real case needs it:**
- **Multicast** (`keys(event)` returning several keys): the fleet needs it to reach every rule of a robot, so it is the first extension, built right after the core; it stays out of the core so the first lesson is one key.
- **`retain`**: until the outbox admin actually wants to linger on "sent", completion is immediate.
- **`concurrency`** and **`effects: 'serial' | 'latest'`**: start as chart patterns. Out-of-order summary writes are prevented by a sequence number in context that the write's completion checks, which is a guard, not a primitive; IndiePub sites never restore hundreds of sends at once.
- **Residence** (`resident` or `stored`) and **passivation**: paging rarely used app instances out of memory is a real future need for large apps, and the lifecycle vocabulary below is chosen so it slots in without renaming anything. It is not part of the first surface, every family is resident, and the guide does not mention activation or passivation until it ships.
- **Group membership** (`members(event)`): deferred, see Open Questions.

## Success Criteria

A machine definition can declare a keyed family such that: (a) an instance's effect completion and `after` timer route to that instance and cannot strand; (b) each record's workflow is a real chart, visible in `describeMachine` and the inspector as one machine with its instances; (c) a per-row component reads its own instance, so a list decomposes into `<Row>` components without find-by-id and a change patches one row; (d) `OutboxMachine` in `@indiepub/stator` becomes an `OutboxSend` family with automatic per-send backoff, and tonysull.co's admin outbox renders one row component per send. Non-breaking: a machine without `family` is unchanged.

## Plan

0. **Settlement, on its own.** Turn ids, cause tracking through effects, `settled` on dispatch results, and `subscribes: [{ settled: true }]`, for plain machines first. It is useful without families, exercises the same dispatch path, and gives the family work a deterministic way to test cascades.
1. **Spike: instance addresses in the registries.** Widen timers, effects, the store's app instances, render bindings and fan-out from `name` to `name[key]` behind an internal API; drive it with a fixture family (app lifecycle, unpersisted, an `after` per instance, effect completions) and the existing suite unchanged. Exit: the fixture's per-instance timers and completions route correctly, `recompute` patches one instance's slot, and the 900 framework tests pass untouched.
2. **The public surface, core only** (see *Surface budget*). `family: { key, creates }`, `seed(event)`, completion on `final`, `family.restore`, the family proxy in reads (`keys`, `of`, aggregate reads), `describeMachine` and the inspector showing a family. Docs: a "collections of workflows" guide replacing the machine-level-`on:` workaround as the recommended shape.
2b. **Multicast**, the first extension, for the fleet app.
3. **Validation in IndiePub.** `OutboxSend` replaces `OutboxMachine` (per-send backoff via `after`), then `MentionVerification` replaces the verifying map; tonysull.co's outbox list becomes per-send rows. `examples/stockroom` moves to a row family as the framework's own proof.
4. **Persistence and session families**, if the evidence asks.

Target: a 3.x minor, or a late 3.0 beta if stage 2 lands before the release; nothing here depends on the 3.0 cutovers.

## Open Questions

- ~~**Name.**~~ Decided (Tony): `family` and *instance*; existence is *creation* and *completion*, residence is *activation* and *passivation*, defined under *Lifecycle terms*.
- ~~**Group membership.**~~ Deferred until a case needs it. In the fleet app a rule removed from the markdown set is a code change and a redeploy, and a resident unpersisted family is rebuilt from storage at boot, so the removed rule's instances are never created again. Only a group whose members change at runtime, or a persisted family, would need a multicast that declares full membership (`members(event)`, completing unlisted instances) or an explicit removal event.
- ~~**Residence default.**~~ Decided: every family is resident in the first surface, matching app machines today and both production cases (the fleet's robot and rule machines are app machines, always in memory); `stored` and passivation are a later extension (Tony: a sensible way for large apps to page out rarely used app instances, not needed now).
- **Materialisation.** Implicit on a `creates` event (this draft) versus an explicit `CREATE`-style event the app dispatches; the draft keeps it declarative and refuses unknown keys otherwise.
- **Completion timing.** Complete on reaching a `final` state immediately, or after a `retain` window so the UI can show "sent" before the row disappears. The outbox wants a window in the admin; `retain` defaults to zero.
- **Aggregate reads at scale.** Recomputing a family-wide read on every instance change is O(n); fine for hundreds, to be measured before thousands.
- ~~**Settled versus idle.**~~ Answered by the fleet app: settlement per change, grouped by a key (the robot), not family-wide idle.
- ~~**Do timers belong to the change?**~~ Answered by the fleet app: no. A delayed raise holding the robot update open would delay every summary by 30 s; as its own change it produces the summary the app wants when it fires.
- ~~**Scale.**~~ The fleet app peaks around 2,000 instances (160 robots × 12 rules), trivially within reach for timers, memory and an O(n) family-wide read; the spike measures at 10× that to leave headroom.
- **Keys in `subscribes`.** Whether a subscription into a family must name its key function explicitly or always uses the family's own `key`.

## Implementation Notes

Not started; the approach above is the 2026-11-08 proposal, awaiting decisions. Originally a motivation/direction record. Evidence: `examples/stockroom` (the inventory admin) and its machine test. Related: machine-level `on:` (shipped, Evidence 1's drop fix), per-row item-value bindings (Evidence 3's inline stopgap), the parallel-regions RFC (design exploration).

**Anticipated second evidence point (2026-09-10):** the personal-site IndiePub-on-Stator port (dogfooding thread) will need per-record retry/backoff timers for at least two independent record collections — outbox entries (automatic webmention-send retry, today owner-button-only in `examples/indie-blog`) and pending mentions (re-verification retries) — matching this spec's own "Evidence 2" occurrence in `indie-blog`'s outbox. Deliberately not started yet; held until that dogfood actually needs it, per the "decision deferred to a second collection example" framing above. Recorded here only so the connection isn't lost when that work starts.
