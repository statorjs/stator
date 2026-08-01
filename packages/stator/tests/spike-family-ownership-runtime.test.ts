// SPIKE (child-machine composition, ownership): the two prior gates prove a
// child machine in ISOLATION — it types (spike-async-update.test-d.ts) and it
// RUNS with an injected effect (spike-async-update-runtime.test.ts). Neither
// proves the missing runtime piece: can a HOST own a KEYED FAMILY of them —
// spawn one child per key, route an event to the right child, read a child's
// state back, and dispose it — each child an independent actor?
//
// This spike answers yes, on top of the EXISTING engine (createActor), with no
// new engine surface — the same way the reusable-machine spikes needed nothing
// new. `createFamily` is the minimal ownership primitive: a keyed map of child
// actors. It honors the settled authoring API — `AsyncUpdate(op)` is op-first /
// name-optional (per-instance identity is the FAMILY KEY, not def.name), and
// `keyed(keyFn, def)` is the mount shape (op injected at definition, key derived
// at dispatch).
//
// BOUNDARY (deferred, as in the runtime spike): children run their effects
// LOCALLY (onEffect omitted → microtask + self-send). Routing child effects
// through a server session's off-lock effect queue, and per-key persistence, are
// the next layer — this proves the ownership MECHANIC, not the server wiring.
import { describe, expect, it } from 'vitest'
import {
  type Actor,
  type CreateActorOptions,
  createActor,
  defineMachine,
  type EventObject,
  type MachineDef,
} from '../src/engine/index.ts'

/** The reusable async-op child — op-first, name-optional (the settled signature:
 *  a keyed family owns identity, so the factory takes no required `name`). */
function AsyncUpdate<TPayload, TResult>(
  op: (payload: TPayload) => Promise<TResult>,
  opts: { label?: string } = {},
) {
  type Events =
    | { type: 'SUBMIT'; payload: TPayload }
    | { type: 'OK'; result: TResult }
    | { type: 'FAIL'; error: string }
    | { type: 'RETRY'; payload: TPayload }

  const run = async (payload: TPayload): Promise<Events> => {
    try {
      return { type: 'OK', result: await op(payload) }
    } catch (e) {
      return { type: 'FAIL', error: String(e) }
    }
  }

  return defineMachine({
    name: opts.label ?? 'AsyncUpdate',
    lifecycle: 'session',
    events: {} as Events,
    context: { attempt: 0, error: '', result: null as TResult | null },
    initial: 'idle',
    states: {
      idle: {
        on: {
          SUBMIT: {
            to: 'running',
            do: (ctx) => {
              ctx.attempt += 1
            },
            effect: (_ctx, ev) => run(ev.payload),
          },
        },
      },
      running: {
        on: {
          OK: {
            to: 'settled',
            do: (ctx, ev) => {
              ctx.result = ev.result
              ctx.error = ''
            },
          },
          FAIL: {
            to: 'failed',
            do: (ctx, ev) => {
              ctx.error = ev.error
            },
          },
        },
      },
      settled: {},
      failed: {
        on: {
          RETRY: {
            to: 'running',
            do: (ctx) => {
              ctx.attempt += 1
            },
            effect: (_ctx, ev) => run(ev.payload),
          },
        },
      },
    },
    selectors: {
      result: (ctx) => ctx.result,
      error: (ctx) => ctx.error,
      attempt: (ctx) => ctx.attempt,
    },
  })
}

/** The mount shape: pair a key-deriving function with a child def. Op is already
 *  injected into `def`; `keyFn` is the collection/identity dimension only —
 *  `keyed(keyFn, factory(op))`, the two concerns kept flat and orthogonal. */
function keyed<R, C extends object, E extends EventObject, S extends string>(
  keyFn: (record: R) => string,
  def: MachineDef<C, E, S>,
) {
  return { keyFn, def }
}

/** The minimal ownership primitive: a host-owned keyed family of child actors.
 *  Spawn-on-first-touch, route by key, read a child's state, dispose. Built
 *  entirely on `createActor` — this is the shape a real `family:` field would
 *  lower to. */
function createFamily<R, C extends object, E extends EventObject, S extends string>(
  mount: { keyFn: (record: R) => string; def: MachineDef<C, E, S> },
  opts: CreateActorOptions<C> = {},
) {
  const children = new Map<string, Actor<C, E>>()

  const ensure = (key: string): Actor<C, E> => {
    let child = children.get(key)
    if (!child) {
      child = createActor(mount.def, opts).start()
      children.set(key, child)
    }
    return child
  }

  return {
    /** Route an event to a keyed child, spawning it on first touch. */
    send: (key: string, event: E) => ensure(key).send(event),
    /** Route by DERIVING the key from a record (the `keyFn` dimension). */
    dispatch: (record: R, event: E) => ensure(mount.keyFn(record)).send(event),
    /** Read a child's state back — the `read(family(id), …)` analog. */
    stateOf: (key: string) => children.get(key)?.getSnapshot().value[0],
    snapshotOf: (key: string) => children.get(key)?.getSnapshot(),
    has: (key: string) => children.has(key),
    keys: () => [...children.keys()],
    size: () => children.size,
    /** Dispose a child (a row removed): stop it and forget the key. */
    remove: (key: string) => {
      children.get(key)?.stop()
      children.delete(key)
    },
  }
}

/** Flush microtasks + the injected op's promise so local effects complete. */
const flush = () => new Promise((r) => setTimeout(r, 0))

/** A representative op: commit a row's qty, return its new version. */
const commit = async (p: { id: string; qty: number }): Promise<{ version: number }> => ({
  version: p.qty + 1,
})

describe('Family ownership runtime spike (a host owns a keyed family of children)', () => {
  it('spawns one child per key; keys run independently; state reads back', async () => {
    const saves = createFamily(keyed((r: { id: string; qty: number }) => r.id, AsyncUpdate(commit)))

    saves.send('a', { type: 'SUBMIT', payload: { id: 'a', qty: 5 } })
    saves.send('b', { type: 'SUBMIT', payload: { id: 'b', qty: 9 } })

    // Two distinct child actors, each in flight under its own key.
    expect(saves.size()).toBe(2)
    expect(saves.keys().sort()).toEqual(['a', 'b'])
    expect(saves.stateOf('a')).toBe('running')
    expect(saves.stateOf('b')).toBe('running')

    await flush() // each child's injected op runs; OK routes back through its own event path

    expect(saves.stateOf('a')).toBe('settled')
    expect(saves.stateOf('b')).toBe('settled')
    expect(saves.snapshotOf('a')?.context.result).toEqual({ version: 6 })
    expect(saves.snapshotOf('b')?.context.result).toEqual({ version: 10 })
  })

  it('one child can settle while another is still pending (independent lifecycles)', async () => {
    const saves = createFamily(keyed((r: { id: string; qty: number }) => r.id, AsyncUpdate(commit)))

    saves.send('a', { type: 'SUBMIT', payload: { id: 'a', qty: 1 } })
    await flush() // 'a' settles

    saves.send('b', { type: 'SUBMIT', payload: { id: 'b', qty: 2 } })
    // 'a' is done, 'b' is in flight — a completion for one never strands or touches the other.
    expect(saves.stateOf('a')).toBe('settled')
    expect(saves.stateOf('b')).toBe('running')

    await flush()
    expect(saves.stateOf('b')).toBe('settled')
  })

  it('a child never handled is never spawned (no eager fan-out)', () => {
    const saves = createFamily(keyed((r: { id: string; qty: number }) => r.id, AsyncUpdate(commit)))
    saves.send('a', { type: 'SUBMIT', payload: { id: 'a', qty: 5 } })

    expect(saves.has('a')).toBe(true)
    expect(saves.has('b')).toBe(false) // b was never touched — the family is sparse
    expect(saves.size()).toBe(1)
  })

  it('disposing a key stops it; re-touching spawns a FRESH child (not the disposed one)', async () => {
    const saves = createFamily(keyed((r: { id: string; qty: number }) => r.id, AsyncUpdate(commit)))

    saves.send('a', { type: 'SUBMIT', payload: { id: 'a', qty: 5 } })
    await flush()
    expect(saves.snapshotOf('a')?.context.attempt).toBe(1)

    saves.remove('a')
    expect(saves.has('a')).toBe(false)
    expect(saves.size()).toBe(0)

    // Re-touch the same key: a brand-new actor, attempt back at 1 (proves it is
    // not the disposed instance resurrected).
    saves.send('a', { type: 'SUBMIT', payload: { id: 'a', qty: 7 } })
    expect(saves.stateOf('a')).toBe('running')
    expect(saves.snapshotOf('a')?.context.attempt).toBe(1)
    await flush()
    expect(saves.snapshotOf('a')?.context.result).toEqual({ version: 8 })
  })

  it('the keyed mount derives the child key from the record (dispatch by record)', async () => {
    const saves = createFamily(keyed((r: { id: string; qty: number }) => r.id, AsyncUpdate(commit)))

    const row = { id: 'widget-42', qty: 3 }
    // Host hands the family the RECORD; the mount's keyFn derives the child key.
    saves.dispatch(row, { type: 'SUBMIT', payload: row })

    expect(saves.has('widget-42')).toBe(true) // routed by keyFn(row), not a hand-passed key
    await flush()
    expect(saves.snapshotOf('widget-42')?.context.result).toEqual({ version: 4 })
  })

  it('all children share the factory label yet are distinct, key-addressed actors', async () => {
    // Op-first / name-optional means def.name is a shared LABEL; identity is the
    // family key. Distinct children under one label is exactly the intended model.
    const saves = createFamily(
      keyed((r: { id: string; qty: number }) => r.id, AsyncUpdate(commit, { label: 'save-stock' })),
    )
    saves.send('a', { type: 'SUBMIT', payload: { id: 'a', qty: 5 } })
    saves.send('b', { type: 'SUBMIT', payload: { id: 'b', qty: 6 } })
    await flush()
    // Same label, independent state — the key is what tells them apart.
    expect(saves.snapshotOf('a')?.context.result).toEqual({ version: 6 })
    expect(saves.snapshotOf('b')?.context.result).toEqual({ version: 7 })
    expect(saves.stateOf('a')).toBe('settled')
    expect(saves.stateOf('b')).toBe('settled')
  })
})
