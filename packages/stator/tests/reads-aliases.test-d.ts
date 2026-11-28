// Type-level tests for the machine half of the reads rename: `peers:` types
// `helpers.peers` per peer machine exactly as `reads:` types `helpers.reads`,
// both names are available whichever option declared the list, and `ReadsMap`
// is `PeersMap` under its old name.
import {
  type ActionHelpers,
  createActor,
  defineMachine,
  type PeersMap,
  type ReadsMap,
} from '../src/engine/index.ts'

const Prices = defineMachine({
  name: 'Prices',
  lifecycle: 'app',
  context: { cents: 100 },
  initial: 'ready',
  states: { ready: {} },
  selectors: { cents: (ctx) => ctx.cents },
})

defineMachine({
  name: 'Cart',
  lifecycle: 'session',
  events: {} as { type: 'ADD' },
  peers: [Prices],
  context: { total: 0 },
  initial: 'open',
  states: {
    open: {
      on: {
        ADD: {
          when: (_c, _e, { peers }) => peers.Prices.cents > 0,
          do: (ctx, _e, { peers, reads }) => {
            const viaPeers: number = peers.Prices.cents
            const viaReads: number = reads.Prices.cents
            ctx.total += viaPeers + viaReads
          },
        },
      },
    },
  },
  selectors: {
    total: (_ctx, { peers }) => peers.Prices.cents,
    // @ts-expect-error a machine not declared in peers: is not in the map
    missing: (_ctx, { peers }) => peers.Inventory,
  },
})

// The old spelling still types both helper names.
defineMachine({
  name: 'OldCart',
  lifecycle: 'session',
  reads: [Prices],
  context: {},
  initial: 'open',
  states: { open: {} },
  selectors: {
    viaReads: (_ctx, { reads }) => reads.Prices.cents,
    viaPeers: (_ctx, { peers }) => peers.Prices.cents,
  },
})

// ReadsMap is PeersMap.
type P = PeersMap<[typeof Prices]>
const asReads: ReadsMap<[typeof Prices]> = {} as P
const asPeers: P = asReads
void asPeers

// resolveHelpers takes either key.
createActor(Prices, { resolveHelpers: () => ({ peers: {} }) })
createActor(Prices, { resolveHelpers: () => ({ reads: {} }) })
// @ts-expect-error one of peers or reads is required
createActor(Prices, { resolveHelpers: () => ({}) })

// The accepted type-level break: a hand-built ActionHelpers needs both keys.
// @ts-expect-error peers is missing
const oldStub: ActionHelpers = { reads: {} }
const newStub: ActionHelpers = { peers: {}, reads: {} }
void oldStub
void newStub
