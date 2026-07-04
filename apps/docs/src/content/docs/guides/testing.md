---
title: Testing
description: "The pyramid inverts: most of your app is a pure machine, so most of your tests need no DOM, no browser, no mocks."
sidebar:
  order: 16
---

In client-canonical frameworks, business logic lives inside components, so
testing it means rendering — jsdom, testing-library, mock servers, and a slow
suite that still misses things. Stator's architecture inverts that: your
business logic is a machine that **doesn't know the UI exists**, so the bulk
of your tests are millisecond-fast functions of events in, state out. The
examples below use [Vitest](https://vitest.dev), but nothing here is
runner-specific.

## Machines: test the logic without rendering anything

`createActor` (from `@statorjs/stator/machine`) runs a machine anywhere —
including a plain test file. Send events, assert snapshots:

```ts
import { createActor } from '@statorjs/stator/machine'
import Checkout from '../machines/checkout.ts'

it('refuses to submit an empty cart', () => {
  const actor = createActor(Checkout).start()
  actor.send({ type: 'SUBMIT', token: 'tok' })
  // The guard blocked it: still reviewing.
  expect(actor.getSnapshot().value).toEqual(['reviewing'])
})

it('a full cart moves to submitting', () => {
  const actor = createActor(Checkout, {
    snapshot: { value: ['reviewing'], context: { items: [{ sku: 'desk-01' }], receipt: '' } },
  }).start()
  actor.send({ type: 'SUBMIT', token: 'tok' })
  expect(actor.getSnapshot().value).toEqual(['submitting'])
})
```

Notice the second test: the `snapshot` option **arranges any starting state
directly** — no clicking through the app to reach step three of a flow. That,
plus typed events (a misspelled event type is a compile error in the test
too), is most of what makes this style pay off.

Selectors are plain functions of context — test the interesting ones the same
way you'd test any pure function, through the actor:

```ts
expect(actor.getSnapshot().context.items).toHaveLength(1)
// or through the machine's own lens:
expect(Checkout.selectors.phase(actor.getSnapshot().context)).toBe('ready')
```

## Effects: deterministic async without mocking timers

In a bare actor, [effects](/guides/effects/) run on a microtask and feed
their completion straight back — so the whole pending→complete arc is
testable with one `await`:

```ts
it('a declined charge lands back in reviewing with the error', async () => {
  const actor = createActor(Checkout, { snapshot: fullCart }).start()
  actor.send({ type: 'SUBMIT', token: 'tok_declined' })
  expect(actor.getSnapshot().value).toEqual(['submitting']) // sync commit

  await new Promise((r) => setTimeout(r, 0)) // let the effect settle
  expect(actor.getSnapshot().value).toEqual(['reviewing'])
  expect(actor.getSnapshot().context.error).toBe('card declined')
})
```

When you want full control over timing (or to assert an effect *would* fire
without running it), inject `onEffect` — the same seam the server uses:

```ts
const invocations: EffectInvocation[] = []
const actor = createActor(Checkout, { onEffect: (inv) => invocations.push(inv) }).start()
actor.send({ type: 'SUBMIT', token: 'tok' })

expect(invocations).toHaveLength(1)          // it was scheduled…
const completion = await invocations[0].run() // …run it when YOU choose
actor.send(completion!)                       // …and deliver it when you choose
```

Stale-completion behavior needs no special machinery either: send a
completion event in a state that doesn't handle it and assert nothing
changed — that's the framework's own semantics doing the work.

## The full HTTP loop: no server, no browser

`createApp` returns a `fetch` handler, so route rendering, event dispatch,
patches, sessions, and SSE are all testable with plain `Request` objects:

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
  expect(patches).toContainEqual(
    expect.objectContaining({ op: 'text', value: 'count is 1' }),
  )
})
```

The first GET establishes the session and its render bindings; the POST
asserts the *wire contract* — that this event produces this patch. These are
your integration tests, and there are far fewer of them than machine tests:
they exist to prove the binding between machines and pages, not to re-test
the logic.

## Client islands: the same engine, so the same tests

Island state is built from `machine()` and the same actor engine, so its
logic tests exactly like server machines — in Node, no DOM. When you do want
DOM assertions (bindings, `attrs` coercion), [happy-dom](https://github.com/capricorn86/happy-dom)
is enough; reserve real-browser tests for the few interactions that earn
them.

## Where to spend your budget

- **Most tests: machines.** Guards, transitions, effects, selectors — every
  business rule, at unit-test speed, arranged via snapshots.
- **A thin layer: `app.fetch` integration.** One or two per page proving the
  wiring — render, dispatch, patch.
- **A few: DOM/browser.** Islands and anything that only exists client-side.

If you find yourself wanting a browser test to check a business rule, that's
usually the rule asking to move into a machine — where it becomes a
three-line test.
