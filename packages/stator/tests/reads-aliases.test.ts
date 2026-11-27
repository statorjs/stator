import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createActor, defineMachine, describeMachine } from '../src/engine/index.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'

// The machine half of the reads rename: `peers:` and `helpers.peers` are the
// new names; `reads:` and `helpers.reads` keep working as deprecated aliases
// until 4.0. Internal fields (`def.reads`) stay what the server reads.

const Stock = defineMachine({
  name: 'StockMachine',
  lifecycle: 'app',
  events: {} as { type: 'SET'; qty: number },
  context: { left: 1 },
  initial: 'ready',
  states: {
    ready: {
      on: {
        SET: {
          do: (ctx, ev) => {
            ctx.left = ev.qty
          },
        },
      },
    },
  },
  selectors: { left: (ctx) => ctx.left },
})

type BuyEvents = { type: 'BUY' }

// One machine per spelling, both consulting the peer through the helper of
// the OTHER spelling too, so the mirroring is exercised in both directions.
const WithPeers = defineMachine({
  name: 'WithPeers',
  lifecycle: 'session',
  events: {} as BuyEvents,
  peers: [Stock],
  context: { bought: 0, sawReads: false },
  initial: 'open',
  states: {
    open: {
      on: {
        BUY: {
          when: (_c, _e, { peers, refuse }) => peers.StockMachine.left > 0 || refuse('sold-out'),
          do: (ctx, _e, h) => {
            ctx.bought += 1
            ctx.sawReads = h.reads === h.peers
          },
        },
      },
    },
  },
  selectors: {
    canBuy: (_ctx, { peers }) => peers.StockMachine.left > 0,
  },
})

const WithReads = defineMachine({
  name: 'WithReads',
  lifecycle: 'session',
  events: {} as BuyEvents,
  reads: [Stock],
  context: { bought: 0 },
  initial: 'open',
  states: {
    open: {
      on: {
        BUY: {
          when: (_c, _e, { reads }) => reads.StockMachine.left > 0,
          do: (ctx) => {
            ctx.bought += 1
          },
        },
      },
    },
  },
  selectors: {
    canBuy: (_ctx, { reads }) => reads.StockMachine.left > 0,
  },
})

describe('reads rename: peers on machines', () => {
  it('peers: declares the same list the server reads from def.reads', () => {
    assert.deepStrictEqual(
      WithPeers.peers.map((d) => d.name),
      ['StockMachine'],
    )
    assert.equal(WithPeers.reads, WithPeers.peers)
    assert.equal(WithPeers.deprecatedOptions, undefined)
    assert.equal(WithPeers.capabilities.serverPinned, true)
  })

  it('reads: still declares the list, and is recorded as the deprecated spelling', () => {
    assert.deepStrictEqual(
      WithReads.reads.map((d) => d.name),
      ['StockMachine'],
    )
    assert.equal(WithReads.peers, WithReads.reads)
    assert.deepStrictEqual(WithReads.deprecatedOptions, ['reads'])
    assert.equal(WithReads.capabilities.serverPinned, true)
  })

  it('a machine with neither has empty peers and reads', () => {
    const M = defineMachine({
      name: 'Alone',
      lifecycle: 'session',
      context: {},
      initial: 'a',
      states: { a: {} },
    })
    assert.deepStrictEqual(M.peers, [])
    assert.equal(M.reads, M.peers)
    assert.equal(M.deprecatedOptions, undefined)
  })

  it('declaring both peers and reads throws, naming the one to keep', () => {
    assert.throws(
      () =>
        defineMachine({
          name: 'Both',
          lifecycle: 'session',
          peers: [Stock],
          reads: [Stock],
          context: {},
          initial: 'a',
          states: { a: {} },
        }),
      /machine "Both" got both peers and reads — keep peers \(reads is its old name\)/,
    )
  })

  it('a def spread back into defineMachine keeps its peers without tripping the both-set check', () => {
    const Derived = defineMachine({
      ...(WithPeers as object),
      name: 'Derived',
    } as never) as typeof WithPeers
    assert.deepStrictEqual(
      Derived.peers.map((d) => d.name),
      ['StockMachine'],
    )
    assert.equal(Derived.deprecatedOptions, undefined)
  })

  it('a resolveHelpers stub under either key reaches a machine using either name', () => {
    const stock = { StockMachine: { left: 1 } }
    for (const def of [WithPeers, WithReads]) {
      for (const resolveHelpers of [() => ({ peers: stock }), () => ({ reads: stock })]) {
        const a = createActor(def as typeof WithPeers, { resolveHelpers }).start()
        assert.deepStrictEqual(a.send({ type: 'BUY' }), { committed: true }, def.name)
        assert.equal(a.getSnapshot().context.bought, 1)
      }
    }
    const a = createActor(WithPeers, { resolveHelpers: () => ({ reads: stock }) }).start()
    a.send({ type: 'BUY' })
    assert.equal(a.getSnapshot().context.sawReads, true)
  })

  it('a guard reading helpers.peers can refuse with a reason', () => {
    const a = createActor(WithPeers, {
      resolveHelpers: () => ({ peers: { StockMachine: { left: 0 } } }),
    }).start()
    assert.deepStrictEqual(a.send({ type: 'BUY' }), {
      committed: false,
      refusal: { code: 'sold-out' },
    })
  })

  it('with no resolver, peers and reads both throw a message naming peers', () => {
    const viaPeers = createActor(WithPeers).start()
    assert.throws(() => viaPeers.send({ type: 'BUY' }), /accessed peers\.StockMachine/)
    const viaReads = createActor(WithReads).start()
    assert.throws(() => viaReads.send({ type: 'BUY' }), /accessed peers\.StockMachine/)
  })

  it('the server resolves helpers.peers and helpers.reads to the same proxies', async () => {
    const store = new MachineStore([Stock, WithPeers, WithReads] as never, new InMemoryStore())
    await store.bootAppMachines()
    const runtime = new SessionRuntime('peers-alias', store)
    await runtime.loadGraph([WithPeers, WithReads] as never)

    const peersView = runtime.proxyFor('WithPeers') as unknown as { canBuy: boolean }
    const readsView = runtime.proxyFor('WithReads') as unknown as { canBuy: boolean }
    assert.equal(peersView.canBuy, true)
    assert.equal(readsView.canBuy, true)

    runtime.processEvent('WithPeers', { type: 'BUY' })
    runtime.processEvent('WithReads', { type: 'BUY' })
    const ctx = (name: string) =>
      runtime.handleFor(name)!.actor.getSnapshot().context as { bought: number; sawReads?: boolean }
    assert.equal(ctx('WithPeers').bought, 1)
    assert.equal(ctx('WithPeers').sawReads, true)
    assert.equal(ctx('WithReads').bought, 1)

    store.appInstance('StockMachine')!.actor.send({ type: 'SET', qty: 0 } as never)
    assert.equal(peersView.canBuy, false)
    assert.equal(readsView.canBuy, false)
  })

  it('describeMachine reports peers beside reads', () => {
    const d = describeMachine(WithPeers)
    assert.deepStrictEqual(d.peers, ['StockMachine'])
    assert.deepStrictEqual(d.reads, ['StockMachine'])
    assert.deepStrictEqual(describeMachine(WithReads).peers, ['StockMachine'])
  })
})
