import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dispatchToApp } from '../src/server/app-dispatch.ts'
import { createApp } from '../src/server/create-app.ts'
import CacheMachine from './fixtures/app-lifecycle/machines/cache.ts'
import { waitFor } from './helpers/mocks.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures/app-lifecycle')

const boot = () =>
  createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
  })
type App = Awaited<ReturnType<typeof boot>>

const snap = (app: App) => app.store.appInstance('CacheMachine')!.actor.getSnapshot()
const stateOf = (app: App) => snap(app).value

describe('app-machine lifecycle parity (entry effects + `after`)', () => {
  it('fires the initial-state entry effect on boot', async () => {
    const app = await boot()
    // boot schedules loading.entry (through the app effect scheduler, wired
    // before boot); it completes on a microtask and lands the stable `ready`.
    await waitFor(() => {
      assert.deepStrictEqual(stateOf(app), ['ready'])
    })
    assert.partialDeepStrictEqual(snap(app).context, { data: 'v1', loads: 1 })
  })

  it('arms an `after` timer at app scope — the state self-expires on wall-clock', async () => {
    const app = await boot()
    await waitFor(() => assert.deepStrictEqual(stateOf(app), ['ready']))

    // Enter the timed state; no request, no session from here — the 40ms timer
    // fires purely on wall-clock and re-enters via dispatchToApp, landing `ticked`.
    await dispatchToApp(app.store, CacheMachine, { type: 'WATCH' })
    assert.deepStrictEqual(stateOf(app), ['watching'])
    await waitFor(() => assert.deepStrictEqual(stateOf(app), ['ticked']), {
      timeout: 2000,
      interval: 10,
    })
  })

  it('cancels the `after` timer when the state is left first', async () => {
    const app = await boot()
    await waitFor(() => assert.deepStrictEqual(stateOf(app), ['ready']))

    await dispatchToApp(app.store, CacheMachine, { type: 'WATCH' })
    // Leave `watching` via PIN before its 40ms timeout — onStateExit cancels the
    // TICK timer.
    const { committed } = await dispatchToApp(app.store, CacheMachine, { type: 'PIN' })
    assert.equal(committed, true)
    assert.deepStrictEqual(stateOf(app), ['pinned'])

    // Past the original timeout: the cancelled timer must not fire TICK.
    await new Promise((r) => setTimeout(r, 100))
    assert.deepStrictEqual(stateOf(app), ['pinned'])
  })
})
