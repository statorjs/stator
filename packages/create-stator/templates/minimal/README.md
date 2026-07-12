# A Stator app

```sh
pnpm install
pnpm dev        # dev server with live reload + the wire inspector
pnpm typecheck  # sync generated component types, then tsc
pnpm build      # production build into dist/
pnpm start      # serve the production build
```

## The mental model

State lives **on the server**, in machines. Pages declare what they read;
when an event changes a machine, the server diffs and sends small JSON
patches to the browser. There is no client renderer and no API layer.

- `machines/counter.ts` — a session-scoped machine: typed events, guarded
  transitions, selectors. Session state survives a page reload because the
  server owns it.
- `routes/index.stator` — a page: frontmatter declares `Stator.reads`, the
  template calls `read(machine, selector)` wherever live values render.
- `templates/layout.stator` — a component with a `<children />` slot.

Try it: run `pnpm dev`, click **+1**, then reload the page — the count
persists. Open the inspector (bottom of the page) and click again to watch
the patch arrive on the wire.

## Learn more

- Docs: https://docs.statorjs.dev — start with the tutorial
- Reference app: https://demo.statorjs.dev ([source](https://github.com/statorjs/stator/tree/main/apps/store))
