import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { routeOfferedEvents, scanOffered } from '../src/build/offered-events.ts'

/**
 * What a route offers the browser, read from source: the event types its
 * templates and islands send. `/__events` accepts nothing else (see
 * event-gate.test.ts for the wire).
 */

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, 'fixtures/offered-events')
const offered = async (route: string) => {
  const o = await routeOfferedEvents(resolve(app, 'routes', route), app)
  return { types: [...o.types].sort(), open: o.open }
}

describe('scanOffered: one module', () => {
  const types = (code: string, side: 'server' | 'client' | 'module') =>
    scanOffered(code, 'x.ts', side)

  it('reads a send by its literal type', () => {
    assert.deepEqual(types("on('click', () => cart.send({ type: 'ADD', id }))", 'server'), {
      types: ['ADD'],
      open: [],
    })
    assert.deepEqual(
      types("cart.send({ type: ok ? 'A' : ('B' as const), n }); x.send('C')", 'server').types,
      ['A', 'B', 'C'],
    )
  })

  it('a computed type is open, with its line', () => {
    assert.deepEqual(types('const a = 1\ncart.send({ type: kind })\ncart.send(ev)', 'server'), {
      types: [],
      open: [2, 3],
    })
    assert.deepEqual(types('cart.send({ ...ev })', 'server').open, [1])
  })

  it('a client module offers what it dispatches, not what it sends to its own machines', () => {
    assert.deepEqual(
      types("this.qty.send('INC'); dispatch(Cart, { type: 'ADD' }); dispatch(Cart, ev)", 'client'),
      { types: ['ADD'], open: [1] },
    )
  })

  it('a server module does not dispatch', () => {
    assert.deepEqual(types("dispatch(Cart, { type: 'ADD' })", 'server'), { types: [], open: [] })
  })

  it('a plain module: literals count, a computed send only inside on()', () => {
    assert.deepEqual(types("actor.send(event); x.send({ type: 'A' })", 'module'), {
      types: ['A'],
      open: [],
    })
    assert.deepEqual(types("on('click', () => cart.send(ev))", 'module').open, [1])
  })

  it('a send in a comment or a string is not one', () => {
    assert.deepEqual(
      types("// cart.send({ type: 'A' })\nconst s = \"x.send({ type: 'B' })\"", 'server'),
      {
        types: [],
        open: [],
      },
    )
  })
})

describe('routeOfferedEvents: everything a route can render', () => {
  it('unions templates, inactive arms, rows, fence handlers and islands', async () => {
    // CLEAR from a fence-defined handler, REMOVE from an `each` row, CHECKOUT
    // from a `when` arm that is off for an empty cart, ADD from the island's
    // script, PING from a module the island imports.
    assert.deepEqual(await offered('index.stator'), {
      types: ['ADD', 'CHECKOUT', 'CLEAR', 'PING', 'REMOVE'],
      open: [],
    })
  })

  it('leaves out what no UI sends: completions, timers, a client machine’s events', async () => {
    const { types } = await offered('index.stator')
    for (const t of ['CHARGE_OK', 'CHARGE_TIMEOUT', 'BUMP']) assert.ok(!types.includes(t), t)
  })

  it('a page with no handlers offers nothing', async () => {
    assert.deepEqual(await offered('bare.stator'), { types: [], open: [] })
  })

  it('a computed event type makes the route open, naming the file', async () => {
    const o = await offered('computed.stator')
    assert.deepEqual(o.open, ['routes/computed.stator:1'])
  })

  it('reads a hand-written html route', async () => {
    assert.deepEqual(await offered('manual.ts'), { types: ['CLEAR'], open: [] })
  })
})
