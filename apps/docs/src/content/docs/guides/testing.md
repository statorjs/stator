---
title: Testing
description: "The pyramid inverts: most of your app is a pure machine, so most of your tests need no DOM, no browser, no mocks."
sidebar:
  order: 16
---

In client-canonical frameworks, business logic lives inside components, so testing it means rendering — jsdom, testing-library, mock servers, and a slow suite that still misses things. Stator's architecture inverts that: your business logic is a machine that **doesn't know the UI exists**, so the bulk of your tests are millisecond-fast functions of events in, state out. The examples below use Node's built-in test runner, which is what `stator test` runs, but nothing here is runner-specific.

## Machines: test the logic without rendering anything

`createActor` (from `@statorjs/stator/machine`) spins up an [actor](/concepts/state-machines/#definition-actor-instance) — a running machine — anywhere, including a plain test file. Send events, assert snapshots. Tests use Node's own runner and assertions (`node:test`, `node:assert/strict`), so there is nothing to install:

```ts
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createActor } from '@statorjs/stator/machine'
import Checkout from '../machines/checkout.ts'

it('refuses to submit an empty cart', () => {
  const actor = createActor(Checkout).start()
  actor.send({ type: 'SUBMIT', token: 'tok' })
  // The guard blocked it: still reviewing.
  assert.deepStrictEqual(actor.getSnapshot().value, ['reviewing'])
})

it('a full cart moves to submitting', () => {
  const actor = createActor(Checkout, {
    snapshot: { value: ['reviewing'], context: { items: [{ sku: 'desk-01' }], receipt: '' } },
  }).start()
  actor.send({ type: 'SUBMIT', token: 'tok' })
  assert.deepStrictEqual(actor.getSnapshot().value, ['submitting'])
})
```

Notice the second test: the `snapshot` option **arranges any starting state directly** — no clicking through the app to reach step three of a flow. That, plus typed events (a misspelled event type is a compile error in the test too), is most of what makes this style pay off.

Selectors are plain functions of context — test the interesting ones the same way you'd test any pure function, through the actor:

```ts
assert.equal(actor.getSnapshot().context.items.length, 1)
// or through the machine's own lens:
assert.equal(Checkout.selectors.phase(actor.getSnapshot().context), 'ready')
```

## Effects: deterministic async without mocking timers

In a bare actor, [effects](/guides/effects/) run on a microtask and feed their completion straight back — so the whole pending→complete arc is testable with one `await`:

```ts
it('a declined charge lands back in reviewing with the error', async () => {
  const actor = createActor(Checkout, { snapshot: fullCart }).start()
  actor.send({ type: 'SUBMIT', token: 'tok_declined' })
  assert.deepStrictEqual(actor.getSnapshot().value, ['submitting']) // sync commit

  await new Promise((r) => setTimeout(r, 0)) // let the effect settle
  assert.deepStrictEqual(actor.getSnapshot().value, ['reviewing'])
  assert.equal(actor.getSnapshot().context.error, 'card declined')
})
```

When you want full control over timing (or to assert an effect *would* fire without running it), inject `onEffect` — the same seam the server uses:

```ts
const invocations: EffectInvocation[] = []
const actor = createActor(Checkout, { onEffect: (inv) => invocations.push(inv) }).start()
actor.send({ type: 'SUBMIT', token: 'tok' })

assert.equal(invocations.length, 1)          // it was scheduled…
const completion = await invocations[0].run() // …run it when YOU choose
actor.send(completion!)                       // …and deliver it when you choose
```

Stale-completion behavior needs no special machinery either: send a completion event in a state that doesn't handle it and assert nothing changed — that's the framework's own semantics doing the work.

## The full HTTP loop: no server, no browser

`createApp` returns a `fetch` handler, so route rendering, event dispatch, patches, sessions, and SSE are all testable with plain `Request` objects:

```ts
import { createApp } from '@statorjs/stator/server'

const app = await createApp({
  machinesDir: resolve(here, '../machines'),
  routesDir: resolve(here, '../routes'),
})

it('adding to the cart patches the header count', async () => {
  const page = await app.fetch(new Request('http://test/'))
  const cookie = page.headers.get('set-cookie')!.split(';')[0]!

  const res = await app.fetch(
    new Request('http://test/__events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stator-Route': 'GET /',
        Cookie: cookie,
      },
      body: JSON.stringify({ machine: 'CartMachine', event: { type: 'ADD', productId: 'p1' } }),
    }),
  )

  const { patches } = await res.json()
  assert.ok(patches.some((p: { op: string; value?: string }) => p.op === 'text' && p.value === 'count is 1'))
})
```

The first GET establishes the session and its render bindings; the POST asserts the *wire contract* — that this event produces this patch. These are your integration tests, and there are far fewer of them than machine tests: they exist to prove the binding between machines and pages, not to re-test the logic.

## Client islands: the same engine, so the same tests

Island state is built from `machine()` and the same actor engine, so its logic tests exactly like server machines — in Node, no DOM. When you do want DOM assertions (bindings, `attrs` coercion), [happy-dom](https://github.com/capricorn86/happy-dom) is enough: add it as a dev dependency and put `// @env happy-dom` on its own line in that test file, and `stator test` gives that file, and only that file, browser globals. Reserve real-browser tests for the few interactions that earn them.

## Running the suite

`stator test` runs every `*.test.ts` and `*.spec.ts` under the app with Node's test runner, each file in its own process. Arguments pass through: name files to run only those (`stator test tests/cart.test.ts`), or add Node's flags (`stator test --watch`, `--test-name-pattern`, `--experimental-test-coverage`). Framework logging is silent during tests; export `LOG_LEVEL` to bring it back while debugging. Spies and fake timers come from `node:test`'s `mock` (`mock.fn`, `mock.method`, `mock.timers`).

Stator ships its source as TypeScript and loads it with its own loader. Packages built on Stator (component libraries, runtime packages) ship JS that imports that source. Node won't strip types inside `node_modules`, so any process that imports such a package needs Stator's loader registered first. `stator dev`, `start`, `build` and `test` register it themselves.

Anything else that runs your code (an editor's test runner, a maintenance script) registers it with one flag:

```sh
node --import @statorjs/stator/register --test tests/cart.test.ts
node --import @statorjs/stator/register scripts/backfill.ts
```

For an editor extension, set the same `NODE_OPTIONS` in its environment setting.

Without it, the failure looks like `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. From a linked checkout, it reads "parameter property is not supported in strip-only mode".

## Where to spend your budget

- **Most tests: machines.** Guards, transitions, effects, selectors — every business rule, at unit-test speed, arranged via snapshots.
- **A thin layer: `app.fetch` integration.** One or two per page proving the wiring — render, dispatch, patch.
- **A few: DOM/browser.** Islands and anything that only exists client-side.

If you find yourself wanting a browser test to check a business rule, that's usually the rule asking to move into a machine — where it becomes a three-line test.
