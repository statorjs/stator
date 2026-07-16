import { defineMachine } from '@statorjs/stator/server'

/**
 * Server-canonical display preferences. Because this is a `session` machine, the
 * choice persists per visitor (through the Store) and — the standout part —
 * syncs live across every open tab over SSE: toggle units in one tab and the
 * others reformat instantly, with no client-side state.
 *
 * `WeatherMachine` subscribes to `CHANGED` and mirrors these into its own context
 * (a live binding's selector sees only its own machine, so the machine that
 * *renders* the temperatures needs the unit local to re-render on toggle).
 */

export type Units = 'metric' | 'imperial'
export type Clock = '12h' | '24h'

interface Ctx {
  units: Units
  clock: Clock
}

type Events =
  | { type: 'TOGGLE_UNITS' }
  | { type: 'SET_UNITS'; units: Units }
  | { type: 'TOGGLE_CLOCK' }
  | { type: 'SET_CLOCK'; clock: Clock }

export default defineMachine({
  name: 'SettingsMachine',
  lifecycle: 'session',
  events: {} as Events,
  emits: {
    CHANGED: {
      payload: (ctx: Ctx) => ({ units: ctx.units, clock: ctx.clock }),
    },
  },
  context: { units: 'metric', clock: '24h' } as Ctx,
  initial: 'ready',
  states: {
    ready: {
      on: {
        TOGGLE_UNITS: {
          do: (ctx) => {
            ctx.units = ctx.units === 'metric' ? 'imperial' : 'metric'
          },
          emit: 'CHANGED',
        },
        SET_UNITS: {
          do: (ctx, ev) => {
            if (ev.units === 'metric' || ev.units === 'imperial') ctx.units = ev.units
          },
          emit: 'CHANGED',
        },
        TOGGLE_CLOCK: {
          do: (ctx) => {
            ctx.clock = ctx.clock === '24h' ? '12h' : '24h'
          },
          emit: 'CHANGED',
        },
        SET_CLOCK: {
          do: (ctx, ev) => {
            if (ev.clock === '12h' || ev.clock === '24h') ctx.clock = ev.clock
          },
          emit: 'CHANGED',
        },
      },
    },
  },
  selectors: {
    units: (ctx) => ctx.units,
    clock: (ctx) => ctx.clock,
  },
})
