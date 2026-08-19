---
"@statorjs/stator": minor
---

`boot.ts` — run code once when the server starts. A root-level `boot.ts` (auto-discovered like `middleware.ts`) is the home for a long-lived inbound source: query config at startup, then start a poll or subscription that feeds events into the app-machine graph.

```ts
// boot.ts
import { defineBoot } from '@statorjs/stator/server'
import FleetMachine from './machines/fleet.ts'

export default defineBoot(async ({ dispatchToApp }) => {
  const timer = setInterval(
    async () => dispatchToApp(FleetMachine, { type: 'TICK', data: await poll() }),
    30_000,
  )
  return () => clearInterval(timer) // teardown, composed into graceful shutdown
})
```

- Runs **once per process** when the app starts listening (a dev restart re-runs it; an in-process rebuild does not; tests that only `app.fetch` never trigger it).
- **`BootContext` is deliberately narrow** — `dispatchToApp` (feed the app-machine graph) and a read-only `config`. Not the raw app: no `listen`/`fetch`/`hono`/store, because boot is a *source*, not a controller. Env stays ambient (`process.env` is loaded before boot runs).
- Return a **teardown** to clean up on shutdown (clear a timer, unsubscribe a source).

Cadence *policy* belongs in the machine (a guard can debounce a `TICK` by state — unit-testable with `createActor`), not in the boot closure.
