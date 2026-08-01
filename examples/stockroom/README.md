# Stockroom — an editable inventory admin

A table of stock records. Each row has its own async save with optimistic
concurrency, and a toolbar "Refresh" reloads the whole collection. The shape
behind admin tools, dashboards, and queues — a *collection of per-record
workflows*.

```sh
pnpm install
pnpm dev        # dev server with live reload + the wire inspector
pnpm test       # the machine's rules, no browser
pnpm typecheck  # sync generated component types, then tsc
```

## The mental model

State lives on the server, in `machines/inventory.ts`. The page declares what it
reads, and when an event changes the machine the server diffs and sends small
patches. Editing a quantity dispatches `ADJUST`, saving dispatches `SAVE` which
runs an async command effect, and the row's status updates live over the wire.

- `machines/inventory.ts` — one machine with two state axes: a chart-level
  freshness axis (`loading` / `ready`) and a per-record save workflow.
- `lib/inventory-source.ts` — a stand-in datastore with per-record versions and
  simulated latency, so saves are genuinely conflict-checked.
- `routes/index.stator` — the table, a keyed `each` of `<tr>` with per-row
  steppers and save buttons.

## A teaching example that also pressure-tested the framework

Built the natural, flat way a user reaches for first — which exercises several
distinctive parts of Stator:

- **A reactive `each` of `<tr>` inside `<tbody>`** — regions are delimited by
  comment markers, so a live table renders (and filtering/deleting rows works)
  where an injected wrapper element would be foster-parented out.
- **Machine-level `on:`** — the per-record save completions are handled in any
  state, so a `Refresh` mid-save doesn't strand a row (see `pnpm test`).
- **Per-row item reads** — the live cells use `read(row, …)`; the save status
  still reads the machine by id, because the per-record workflow lives in a
  context map rather than its own chart.

That last asymmetry is deliberate: it motivates the per-record **child-machine**
composition direction. So this is a teaching example and a pressure test at once.

## Learn more

- Docs: https://docs.statorjs.dev — start with the tutorial
