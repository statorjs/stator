import { describe, expect, it, vi } from 'vitest'
import { dispatchToApp } from '../src/server/app-dispatch.ts'
import { InMemoryAppStore } from '../src/server/app-store.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { wireAppEffects } from '../src/server/effects.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'

type TallyEvents = { type: 'BUMP'; by: number } | { type: 'SETTLED'; total: number }

function makeTally(opts?: { persist?: boolean }) {
  return defineMachine({
    name: 'TallyMachine',
    lifecycle: 'app',
    persist: opts?.persist ?? true,
    events: {} as TallyEvents,
    context: { count: 0, settled: 0 },
    initial: 'ready',
    states: {
      ready: {
        on: {
          BUMP: (ctx, ev) => {
            ctx.count += ev.by
          },
          SETTLED: (ctx, ev) => {
            ctx.settled = ev.total
          },
        },
      },
    },
    selectors: { count: (ctx) => ctx.count },
  })
}

describe('app-machine persistence', () => {
  it('rejects persist: true on a session machine at define time', () => {
    expect(() =>
      defineMachine({
        name: 'Bad',
        lifecycle: 'session',
        persist: true,
        context: { n: 0 },
        initial: 'idle',
        states: { idle: {} },
        selectors: {},
      }),
    ).toThrow(/persist: true but is session-lifecycle/)
  })

  it('persists on dispatchToApp and hydrates on the next boot', async () => {
    const appStore = new InMemoryAppStore()
    const Tally = makeTally()

    const store1 = new MachineStore([Tally], new InMemoryStore(), { appStore })
    await store1.bootAppMachines()
    await dispatchToApp(store1, Tally, { type: 'BUMP', by: 5 })
    await dispatchToApp(store1, Tally, { type: 'BUMP', by: 2 })

    // "Restart": a fresh MachineStore over the same AppStore.
    const store2 = new MachineStore([makeTally()], new InMemoryStore(), { appStore })
    await store2.bootAppMachines()
    const snapshot = store2.appInstance('TallyMachine')!.actor.getSnapshot()
    expect((snapshot.context as { count: number }).count).toBe(7)
  })

  it('does not persist machines that did not opt in', async () => {
    const appStore = new InMemoryAppStore()
    const Tally = makeTally({ persist: false })

    const store1 = new MachineStore([Tally], new InMemoryStore(), { appStore })
    await store1.bootAppMachines()
    await dispatchToApp(store1, Tally, { type: 'BUMP', by: 5 })
    expect(await appStore.loadAppMachine('TallyMachine')).toBeNull()

    const store2 = new MachineStore([makeTally({ persist: false })], new InMemoryStore(), {
      appStore,
    })
    await store2.bootAppMachines()
    const snapshot = store2.appInstance('TallyMachine')!.actor.getSnapshot()
    expect((snapshot.context as { count: number }).count).toBe(0)
  })

  it('boots fresh (loudly) when the persisted snapshot is unusable', async () => {
    const appStore = new InMemoryAppStore()
    await appStore.saveAppMachine('TallyMachine', { corrupted: 'yes' })

    const store = new MachineStore([makeTally()], new InMemoryStore(), { appStore })
    await store.bootAppMachines() // must not throw
    const snapshot = store.appInstance('TallyMachine')!.actor.getSnapshot()
    expect((snapshot.context as { count: number }).count).toBe(0)
  })

  it('persists app machines touched via session→app subscriptions', async () => {
    const appStore = new InMemoryAppStore()
    const Tally = makeTally()
    const Clicker = defineMachine({
      name: 'ClickerMachine',
      lifecycle: 'session',
      events: {} as { type: 'CLICK' },
      emits: { clicked: null },
      context: { n: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            CLICK: {
              do: (ctx) => {
                ctx.n += 1
              },
              emit: 'clicked',
            },
          },
        },
      },
      selectors: {},
    })
    const TallyWithSub = defineMachine({
      name: 'TallyMachine',
      lifecycle: 'app',
      persist: true,
      subscribes: [{ from: Clicker, event: 'clicked', dispatch: { type: 'BUMP', by: 1 } }],
      events: {} as TallyEvents,
      context: { count: 0, settled: 0 },
      initial: 'ready',
      states: {
        ready: {
          on: {
            BUMP: (ctx, ev) => {
              ctx.count += ev.by
            },
          },
        },
      },
      selectors: {},
    })
    void Tally

    const store = new MachineStore([Clicker, TallyWithSub], new InMemoryStore(), { appStore })
    await store.bootAppMachines()
    const runtime = new SessionRuntime('s1', store)
    try {
      await runtime.loadGraph([Clicker])
      runtime.wireSubscriptions()
      const touched = runtime.processEvent('ClickerMachine', { type: 'CLICK' })
      expect(touched.has('TallyMachine')).toBe(true)
      await runtime.persistTouched(touched)
    } finally {
      runtime.dispose()
    }

    const saved = (await appStore.loadAppMachine('TallyMachine')) as {
      context: { count: number }
    }
    expect(saved.context.count).toBe(1)
  })
})

describe('app-plane effects (stage 2)', () => {
  it('runs an app-machine effect, dispatches its completion, and persists', async () => {
    const appStore = new InMemoryAppStore()
    const Settler = defineMachine({
      name: 'SettlerMachine',
      lifecycle: 'app',
      persist: true,
      events: {} as TallyEvents,
      context: { count: 0, settled: 0 },
      initial: 'ready',
      states: {
        ready: {
          on: {
            BUMP: {
              do: (ctx, ev) => {
                ctx.count += ev.by
              },
              effect: async (ctx): Promise<TallyEvents | null> => {
                await new Promise((r) => setTimeout(r, 5))
                return { type: 'SETTLED', total: ctx.count * 10 }
              },
            },
            SETTLED: (ctx, ev) => {
              ctx.settled = ev.total
            },
          },
        },
      },
      selectors: {},
    })

    const store = new MachineStore([Settler], new InMemoryStore(), { appStore })
    await store.bootAppMachines()
    wireAppEffects(store)

    await dispatchToApp(store, Settler, { type: 'BUMP', by: 3 })

    await vi.waitFor(async () => {
      const snap = store.appInstance('SettlerMachine')!.actor.getSnapshot()
      expect((snap.context as { settled: number }).settled).toBe(30)
    })
    // The completion's state change was persisted too.
    const saved = (await appStore.loadAppMachine('SettlerMachine')) as {
      context: { settled: number }
    }
    expect(saved.context.settled).toBe(30)
  })

  it('dispatchToApp rejects session machines and unknown machines', async () => {
    const Sess = defineMachine({
      name: 'SessMachine',
      lifecycle: 'session',
      events: {} as { type: 'X' },
      context: { n: 0 },
      initial: 'idle',
      states: { idle: {} },
      selectors: {},
    })
    const store = new MachineStore([Sess], new InMemoryStore())
    await store.bootAppMachines()

    await expect(dispatchToApp(store, Sess, { type: 'X' })).rejects.toThrow(/not app-lifecycle/)
    const Ghost = { ...Sess, name: 'GhostMachine' }
    await expect(dispatchToApp(store, Ghost, { type: 'X' })).rejects.toThrow(/unknown machine/)
  })
})
