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

## A working example that is also a set of findings

This example is built the natural, flat way a user reaches for first, and doing so
surfaces real framework gaps — which is the point. See [`FINDINGS.md`](./FINDINGS.md):

1. **A reactive `each` of `<tr>` mis-renders in the browser** — the region wrapper
   span is not valid table content and gets foster-parented out of the table. The
   app typechecks and serves, but a browser mis-parses the rows. A fix is designed
   (comment-marker regions); this example is its acceptance repro. **The table does
   not render correctly in a browser yet.**
2. **A save completion is stranded** when a refresh moves the machine mid-save —
   a flat machine cannot handle a completion regardless of state. Proven in
   `pnpm test`.
3. **The per-record workflow is invisible in the chart** — its state has to live
   in a context map, so the save status cannot use the clean per-row read the
   quantity does.

Findings 2 and 3 motivate the composition direction — a per-record workflow as its
own machine. So this is a teaching example and a pressure test at once, and it will
graduate to a scaffoldable `--template` once the rendering fix lands.

## Learn more

- Docs: https://docs.statorjs.dev — start with the tutorial
