# @statorjs/stator

A server-canonical web framework: business logic lives in composable state
machines that have no awareness of the UI, and the UI is a thin renderer
binding machine outputs to DOM positions. Templates are `.stator` single-file
components; interactions POST typed events; the server diffs affected bindings
into small JSON patches. Client islands run the same machine engine in the
browser as custom elements.

Full documentation — tutorial, concepts, guides — lives in the repo's
[`apps/docs`](https://github.com/statorjs/stator/tree/main/apps/docs) site;
the repo [README](https://github.com/statorjs/stator#readme) has the tour.

## Install

```bash
pnpm add @statorjs/stator hono
```

> **This package ships TypeScript source, by design.** Stator is
> Vite/tsx-native: the dev server compiles `.stator` (and the framework's own
> `.ts`) through Vite, and production runs the built output under `tsx`. There
> is no `dist/` of transpiled JS — a plain-Node consumer that can't load `.ts`
> modules can't import this package directly. This is a deliberate 1.0 stance,
> not an oversight.

## Entry points

| import | contents |
|---|---|
| `@statorjs/stator/server`   | `createApp`, `defineMachine`, `defineRoute`, `defineApiRoute`, stores, `dispatchToApp` |
| `@statorjs/stator/machine`  | the browser-safe engine core (`defineMachine`, `createActor`) |
| `@statorjs/stator/template` | `html`, `read`, `each`, `when`/`match`, `raw`, directives |
| `@statorjs/stator/client`   | island runtime — `StatorElement`, `use`, `machine`, `bind`, `dispatch` |
| `@statorjs/stator/dev`      | `createDevApp` — the Vite-embedded dev server |
| `@statorjs/stator/build`    | `buildApp`, `loadProductionHead`, `syncTypes` |
| `@statorjs/stator/components` | built-ins (`<JsonLd>`) |

`compiler` and `vite` subpaths exist but are internal — their shape may change
in minor releases.

## Minimal app

```ts
// server.ts
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevApp } from '@statorjs/stator/dev'

const here = dirname(fileURLToPath(import.meta.url))
const app = await createDevApp({
  root: here,
  machinesDir: resolve(here, 'machines'),
  routesDir: resolve(here, 'routes'),
})
await app.listen(3000)
```

```ts
// machines/counter.ts
import { defineMachine } from '@statorjs/stator/server'

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

Run with `tsx server.ts`. See the repo's `examples/desksmith` for the full wiring
(type sync, production build, deploy).

## License

MIT
