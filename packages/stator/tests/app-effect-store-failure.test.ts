import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import pino from 'pino'
import { dispatchToApp } from '../src/server/app-dispatch.ts'
import { InMemoryAppStore } from '../src/server/app-store.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { wireAppEffects } from '../src/server/effects.ts'
import { logger, setLogLevel } from '../src/server/logger.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { waitFor } from './helpers/mocks.ts'

/**
 * An app entry effect settles its pendingEntry marker and persists the machine.
 * The effect runs as `void runAppEffect(...)`, so a store write that rejects
 * there (Redis down for a moment) must be caught: otherwise it is an unhandled
 * rejection, which ends the process.
 */

/** An app store whose next `failNext` writes reject. */
class FlakyAppStore extends InMemoryAppStore {
  failNext = 0
  override async saveAppMachine(name: string, snapshot: unknown): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1
      throw new Error('redis down')
    }
    await super.saveAppMachine(name, snapshot)
  }
}

type Events = { type: 'START' } | { type: 'LOADED' } | { type: 'PING' }

describe('app entry effect: a failed settle write', () => {
  const lines: Array<Record<string, unknown>> = []
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => rejections.push(reason)

  beforeEach(() => {
    lines.length = 0
    rejections.length = 0
    process.on('unhandledRejection', onRejection)
    // Children (the `effect` scope) write through the root's stream.
    const stream = (logger as unknown as Record<symbol, { write: (s: string) => void }>)[
      pino.symbols.streamSym
    ]!
    mock.method(stream, 'write', (s: string) => {
      lines.push(JSON.parse(s))
      return true
    })
    setLogLevel('error')
  })
  afterEach(() => {
    process.off('unhandledRejection', onRejection)
    mock.restoreAll()
    setLogLevel('silent')
  })

  it('is logged, does not reject, and later effects still run', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let pinged = 0
    const Loader = defineMachine({
      name: 'FlakyLoaderMachine',
      lifecycle: 'app',
      persist: true,
      events: {} as Events,
      context: {},
      initial: 'idle',
      states: {
        idle: { on: { START: { to: 'loading' } } },
        loading: {
          entry: async (): Promise<Events | null> => {
            await gate
            return { type: 'LOADED' }
          },
          on: { LOADED: { to: 'ready' } },
        },
        ready: {
          on: {
            PING: {
              effect: async () => {
                pinged += 1
                return null
              },
            },
          },
        },
      },
      selectors: {},
    })
    const appStore = new FlakyAppStore()
    const store = new MachineStore([Loader], new InMemoryStore(), { appStore })
    wireAppEffects(store)
    await store.bootAppMachines()

    await dispatchToApp(store, Loader, { type: 'START' }) // persisted: loading, pending marker
    appStore.failNext = 1 // the settle write is the next one
    release()

    // The completion is still delivered after the failed settle write, and its
    // own persist (which succeeds) leaves the store settled and in `ready`.
    await waitFor(
      async () => {
        const saved = (await appStore.loadAppMachine(Loader.name)) as {
          value: string[]
          pendingEntry?: unknown
        }
        assert.deepEqual(saved.value, ['ready'])
        assert.equal(saved.pendingEntry, undefined)
      },
      { timeout: 2000, interval: 5 },
    )
    assert.equal(appStore.failNext, 0, 'the settle write was attempted and rejected')

    const failed = lines.filter((l) => l.msg === 'entry-effect settle persist failed')
    assert.equal(failed.length, 1)
    assert.equal(failed[0]!.level, 50) // error
    assert.equal(failed[0]!.scope, 'effect')
    assert.equal(failed[0]!.machine, 'FlakyLoaderMachine')
    assert.match(String(failed[0]!.err), /redis down/)

    // A later effect still runs.
    await dispatchToApp(store, Loader, { type: 'PING' })
    await waitFor(() => assert.equal(pinged, 1), { timeout: 2000, interval: 5 })

    // Let any stray rejection surface before checking.
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(rejections, [])
  })
})
