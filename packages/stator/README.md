# @statorjs/stator

A server-canonical web framework: business logic lives in composable state machines that have no awareness of the UI, and the UI is a thin renderer binding machine outputs to DOM positions. Templates are `.stator` single-file components; interactions POST typed events; the server diffs affected bindings into small JSON patches. Client islands run the same machine engine in the browser as custom elements.

Full documentation — tutorial, concepts, guides — lives in the repo's [`apps/docs`](https://github.com/statorjs/stator/tree/main/apps/docs) site; the repo [README](https://github.com/statorjs/stator#readme) has the tour.

## Install

```bash
pnpm add @statorjs/stator hono
```

> **This package ships TypeScript source, by design.** There is no `dist/` of
> transpiled JS. The `stator` CLI registers its own esbuild loader before
> importing anything: `stator dev` runs your source tree through it, and
> `stator start` runs the built `dist/` through it, so neither needs Vite or
> `tsx`. A process the CLI doesn't start (a script, a test runner launched by
> an editor) gets the same loader with
> `node --import @statorjs/stator/register file.ts`; plain Node can't load
> this package's `.ts` from `node_modules` on its own.

## Entry points

| import | contents |
|---|---|
| `@statorjs/stator/machine`  | `defineMachine`, `createActor` — the engine, and the one place a machine is defined from |
| `@statorjs/stator/server`   | `createApp`, `defineRoute`, `defineApiRoute`, stores, `dispatchToApp` |
| `@statorjs/stator/template` | `html`, `read`, `each`, `when`/`match`, `raw`, directives |
| `@statorjs/stator/client`   | island runtime — `StatorElement`, `use`, `machine`, `bind`, `dispatch` |
| `@statorjs/stator/dev`      | `createDevApp` — the dev server `stator dev` runs |
| `@statorjs/stator/build`    | `buildApp`, `loadProductionHead`, `syncTypes` |
| `@statorjs/stator/config`   | `defineConfig` for `stator.config.ts` |
| `@statorjs/stator/components` | built-ins (`<JsonLd>`, `<Image>`, `<Picture>`) |
| `@statorjs/stator/register` | the TS loader, for `node --import` |

The `compiler` and `editor` subpaths exist but are internal — their shape may change in minor releases. Neither is a plugin surface: Stator reads no `vite.config.*` and accepts no bundler plugins.

## Minimal app

```ts
// machines/counter.ts
import { defineMachine } from '@statorjs/stator/machine'

type Events = { type: 'INCREMENT' }

export default defineMachine({
  name: 'CounterMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { count: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        INCREMENT: (ctx) => {
          ctx.count += 1
        },
      },
    },
  },
  selectors: { label: (ctx) => `count is ${ctx.count}` },
})
```

```
// routes/index.stator  (`Stator` is provided by the compiler — no import)
---
import Counter from '../machines/counter.ts'

const [counter] = Stator.reads([Counter])
---
<html>
  <body>
    <p>{read(counter, (c) => c.label)}</p>
    <button on:click={() => counter.send({ type: 'INCREMENT' })}>+</button>
  </body>
</html>
```

Run `stator dev` in the app directory, then `stator build` and `stator start` for production. See the repo's `examples/desksmith` for a fuller app (layouts, an island, tests, production build).

## License

MIT
