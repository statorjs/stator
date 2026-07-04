import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createActor, type EffectInvocation } from '../src/engine/index.ts'
import { createApp } from '../src/server/create-app.ts'
import { defineMachine } from '../src/server/define-machine.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

const tick = () => new Promise((r) => setTimeout(r, 0))

type Events =
  | { type: 'GO'; fail?: boolean }
  | { type: 'OK'; id: string }
  | { type: 'NOPE'; reason: string }

function makeMachine(effectSpy?: (id: string) => void) {
  return defineMachine({
    name: 'FxMachine',
    lifecycle: 'session',
    events: {} as Events,
    context: { result: '' },
    initial: 'idle',
    states: {
      idle: {
        on: {
          GO: {
            to: 'working',
            effect: async (_ctx, ev, meta): Promise<Events | null> => {
              effectSpy?.(meta.effectId)
              await tick()
              return ev.fail ? { type: 'NOPE', reason: 'bad' } : { type: 'OK', id: meta.effectId }
            },
          },
        },
      },
      working: {
        on: {
          OK: {
            to: 'done',
            do: (ctx, ev) => {
              ctx.result = `ok:${ev.id}`
            },
          },
          NOPE: {
            to: 'idle',
            do: (ctx, ev) => {
              ctx.result = `err:${ev.reason}`
            },
          },
        },
      },
      done: {},
    },
    selectors: { result: (ctx) => ctx.result },
  })
}

describe('engine effects: local default scheduling (client plane / unit tests)', () => {
  it('runs the effect after commit and dispatches its completion event', async () => {
    const actor = createActor(makeMachine()).start()
    actor.send({ type: 'GO' })
    // Sync commit happened before any async work:
    expect(actor.getSnapshot().value).toEqual(['working'])
    await tick()
    await tick()
    expect(actor.getSnapshot().value).toEqual(['done'])
    expect(actor.getSnapshot().context.result).toMatch(/^ok:/)
  })

  it('routes the declared failure event', async () => {
    const actor = createActor(makeMachine()).start()
    actor.send({ type: 'GO', fail: true })
    await tick()
    await tick()
    expect(actor.getSnapshot().value).toEqual(['idle'])
    expect(actor.getSnapshot().context.result).toBe('err:bad')
  })

  it('a throwing effect is logged and dropped, never crashes', async () => {
    const machine = defineMachine({
      name: 'ThrowMachine',
      lifecycle: 'session',
      events: {} as { type: 'GO' } | { type: 'OK' },
      context: { n: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO: {
              to: 'working',
              effect: async () => {
                throw new Error('unhandled')
              },
            },
          },
        },
        working: { on: { OK: { to: 'idle' } } },
      },
      selectors: {},
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const actor = createActor(machine).start()
      actor.send({ type: 'GO' })
      await tick()
      await tick()
      expect(actor.getSnapshot().value).toEqual(['working']) // stayed pending
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('must catch and return their failure event'),
        expect.any(Error),
      )
    } finally {
      errSpy.mockRestore()
    }
  })

  it('stamps a unique effectId per invocation and passes it to the effect', async () => {
    const ids: string[] = []
    const machine = makeMachine((id) => ids.push(id))
    const a = createActor(machine).start()
    a.send({ type: 'GO' })
    await tick()
    await tick()
    const b = createActor(machine).start()
    b.send({ type: 'GO' })
    await tick()
    await tick()
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    // The id threads through to the completion (idempotency-key property).
    expect(a.getSnapshot().context.result).toBe(`ok:${ids[0]}`)
  })

  it('stale completions are dropped by ordinary state semantics', async () => {
    const machine = defineMachine({
      name: 'StaleMachine',
      lifecycle: 'session',
      events: {} as { type: 'GO' } | { type: 'OK' } | { type: 'RESET' },
      context: { n: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO: {
              to: 'working',
              effect: async (): Promise<{ type: 'OK' } | null> => {
                await tick()
                return { type: 'OK' }
              },
            },
          },
        },
        working: {
          on: {
            OK: {
              to: 'finished',
              do: (ctx) => {
                ctx.n += 1
              },
            },
            RESET: { to: 'idle' },
          },
        },
        finished: {},
      },
      selectors: {},
    })
    const actor = createActor(machine).start()
    actor.send({ type: 'GO' })
    actor.send({ type: 'RESET' }) // move on before the effect completes
    await tick()
    await tick()
    // The OK arrived in 'idle', which has no handler for it — dropped.
    expect(actor.getSnapshot().value).toEqual(['idle'])
    expect(actor.getSnapshot().context.n).toBe(0)
  })

  it('onEffect hands the invocation to the host instead of running it', async () => {
    const queued: EffectInvocation[] = []
    const actor = createActor(makeMachine(), { onEffect: (inv) => queued.push(inv) }).start()
    actor.send({ type: 'GO' })
    await tick()
    await tick()
    expect(actor.getSnapshot().value).toEqual(['working']) // host owns completion
    expect(queued).toHaveLength(1)
    expect(queued[0]!.machineName).toBe('FxMachine')
    const completion = await queued[0]!.run()
    expect(completion).toEqual({ type: 'OK', id: queued[0]!.effectId })
  })
})

describe('server effects: full HTTP loop', () => {
  async function boot() {
    const app = await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
    })
    const first = await app.fetch(new Request('http://localhost/submitter'))
    const cookie = first.headers.get('set-cookie')!.split(';')[0]!
    return { app, cookie }
  }

  const post = (
    app: Awaited<ReturnType<typeof boot>>['app'],
    cookie: string,
    event: Record<string, unknown>,
  ) =>
    app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /submitter',
          Cookie: cookie,
        },
        body: JSON.stringify({ machine: 'SubmitterMachine', event }),
      }),
    )

  const status = async (app: Awaited<ReturnType<typeof boot>>['app'], cookie: string) => {
    const res = await app.fetch(
      new Request('http://localhost/submitter', { headers: { Cookie: cookie } }),
    )
    const html = await res.text()
    return html.match(/Status: <span[^>]*>([^<]*)</)?.[1]
  }

  it('commits the pending state in the POST response, then completes via the event path', async () => {
    const { app, cookie } = await boot()

    const res = await post(app, cookie, { type: 'SUBMIT' })
    expect(res.status).toBe(200)
    // The response reflects the sync commit only: the status selector's value
    // hasn't changed yet (no receipt, no reason), so no patches — and
    // critically, no completion either. The effect is still in flight.
    const body = (await res.json()) as { patches: Array<{ value?: string }> }
    expect(JSON.stringify(body.patches)).not.toContain('confirmed')

    // Completion re-enters through the event path and persists.
    await vi.waitFor(async () => {
      expect(await status(app, cookie)).toMatch(/^confirmed:r-/)
    })
  })

  it('failure events land the same way', async () => {
    const { app, cookie } = await boot()
    await post(app, cookie, { type: 'SUBMIT', shouldFail: true })
    await vi.waitFor(async () => {
      expect(await status(app, cookie)).toBe('failed:declined')
    })
  })

  it('does not hold the session lock during effect I/O', async () => {
    const { app, cookie } = await boot()

    // Slow effect (150ms). If the lock were held across it, the POKE below
    // would take >150ms to respond.
    await post(app, cookie, { type: 'SUBMIT', delayMs: 150 })
    const before = performance.now()
    const pokeRes = await post(app, cookie, { type: 'POKE' })
    const elapsed = performance.now() - before
    expect(pokeRes.status).toBe(200)
    expect(elapsed).toBeLessThan(100)

    await vi.waitFor(
      async () => {
        expect(await status(app, cookie)).toMatch(/^confirmed:/)
      },
      { timeout: 2000 },
    )
  })
})
