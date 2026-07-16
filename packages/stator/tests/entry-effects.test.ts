import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createActor, type EffectInvocation } from '../src/engine/index.ts'
import { createApp } from '../src/server/create-app.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import {
  loaderEntryFires,
  resetLoaderEntryFires,
} from './fixtures/entry-effects/machines/loader.ts'

const here = dirname(fileURLToPath(import.meta.url))
const efFixtures = resolve(here, 'fixtures/entry-effects')

const tick = () => new Promise((r) => setTimeout(r, 0))

type Events =
  | { type: 'LOADED'; items: string[] }
  | { type: 'RELOAD' } // ready -> loading (value change: fires loading.entry)
  | { type: 'REFRESH' } // ready -> ready (self-transition: no fire)
  | { type: 'NUDGE' } // no `to` (action-only: no fire)

function makeLoader(loadingSpy?: (id: string) => void, readySpy?: (id: string) => void) {
  return defineMachine({
    name: 'Loader',
    lifecycle: 'session',
    events: {} as Events,
    context: { items: [] as string[], nudges: 0 },
    initial: 'loading',
    states: {
      loading: {
        entry: async (_ctx, meta): Promise<Events | null> => {
          loadingSpy?.(meta.effectId)
          await tick()
          return { type: 'LOADED', items: ['a', 'b'] }
        },
        on: {
          LOADED: {
            to: 'ready',
            do: (ctx, ev) => {
              ctx.items = ev.items
            },
          },
        },
      },
      ready: {
        entry: async (_ctx, meta): Promise<Events | null> => {
          readySpy?.(meta.effectId)
          return null
        },
        on: {
          RELOAD: { to: 'loading' },
          REFRESH: { to: 'ready' },
          NUDGE: {
            do: (ctx) => {
              ctx.nudges += 1
            },
          },
        },
      },
    },
    selectors: { items: (ctx) => ctx.items },
  })
}

const hydratedIn = (state: string) => ({
  snapshot: { value: [state], context: { items: [] as string[], nudges: 0 } },
})

describe('entry effects: firing semantics', () => {
  it('fires the initial state entry once on a fresh start; other states do not fire', async () => {
    const loadingSpy = vi.fn()
    const readySpy = vi.fn()
    const queued: EffectInvocation[] = []
    createActor(makeLoader(loadingSpy, readySpy), { onEffect: (i) => queued.push(i) }).start()

    expect(queued).toHaveLength(1)
    // It's loading's entry — its completion is LOADED; ready's entry never ran.
    expect(await queued[0]!.run()).toEqual({ type: 'LOADED', items: ['a', 'b'] })
    expect(loadingSpy).toHaveBeenCalledTimes(1)
    expect(readySpy).not.toHaveBeenCalled()
  })

  it('does NOT fire on hydration into a state the machine is already in', () => {
    const queued: EffectInvocation[] = []
    createActor(makeLoader(), { ...hydratedIn('loading'), onEffect: (i) => queued.push(i) }).start()
    expect(queued).toHaveLength(0)
  })

  it('fires the entered state entry on a value-changing transition', () => {
    const queued: EffectInvocation[] = []
    const actor = createActor(makeLoader(), {
      ...hydratedIn('ready'),
      onEffect: (i) => queued.push(i),
    }).start()
    expect(queued).toHaveLength(0) // hydrated: no fire
    actor.send({ type: 'RELOAD' }) // ready -> loading
    expect(queued).toHaveLength(1) // loading.entry fired
  })

  it('does NOT fire on a self-transition or an action-only transition', () => {
    const queued: EffectInvocation[] = []
    const actor = createActor(makeLoader(), {
      ...hydratedIn('ready'),
      onEffect: (i) => queued.push(i),
    }).start()
    actor.send({ type: 'REFRESH' }) // ready -> ready (self)
    actor.send({ type: 'NUDGE' }) // no `to`
    expect(queued).toHaveLength(0)
    expect(actor.getSnapshot().context.nudges).toBe(1) // the action still ran
  })

  it('firing an entry effect is not a commit', () => {
    const actor = createActor(makeLoader(), { onEffect: () => {} }).start()
    expect(actor.getCommitCount()).toBe(0)
  })

  it('end-to-end (local scheduling): the entry effect drives loading -> ready', async () => {
    const actor = createActor(makeLoader()).start() // no onEffect -> local microtask run
    expect(actor.getSnapshot().value).toEqual(['loading'])
    await tick()
    await tick()
    expect(actor.getSnapshot().value).toEqual(['ready'])
    expect(actor.getSnapshot().context.items).toEqual(['a', 'b'])
  })
})

describe('entry effects over HTTP (GET path)', () => {
  it('a GET fires + persists the entry effect once; the next request hydrates and does not re-fire', async () => {
    resetLoaderEntryFires()
    const app = await createApp({
      machinesDir: resolve(efFixtures, 'machines'),
      routesDir: resolve(efFixtures, 'routes'),
    })

    const r1 = await app.fetch(new Request('http://localhost/loader'))
    expect(r1.status).toBe(200)
    const cookie = r1.headers.get('set-cookie')!.split(';')[0]!

    // The entry effect is scheduled fire-and-forget after the response; let it run.
    await tick()
    await tick()
    expect(loaderEntryFires()).toBe(1)

    // Second GET on the same session: the machine hydrates from the persisted
    // snapshot, so the entry effect does NOT re-fire.
    await app.fetch(new Request('http://localhost/loader', { headers: { Cookie: cookie } }))
    await tick()
    await tick()
    expect(loaderEntryFires()).toBe(1)
  })
})
