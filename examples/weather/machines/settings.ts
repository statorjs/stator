import { defineMachine } from '@statorjs/stator/machine'

/**
 * Server-canonical display preferences. Because this is a `session` machine, the
 * choice persists per visitor (through the Store) and — the standout part —
 * syncs live across every open tab over SSE: toggle units in one tab and the
 * others reformat instantly, with no client-side state.
 *
 * `PanelsMachine` lists this machine in its `reads`, so every formatted
 * temperature and time re-renders when a preference changes.
 */

export type Units = 'metric' | 'imperial'
export type Clock = '12h' | '24h'

/** The app's starting preferences. Change these two to ship different defaults
 *  (e.g. `'imperial'` / `'12h'`). */
export const DEFAULT_UNITS: Units = 'metric'
export const DEFAULT_CLOCK: Clock = '24h'

interface Ctx {
  units: Units
  clock: Clock
}

type Events = { type: 'SET_UNITS'; units: Units } | { type: 'SET_CLOCK'; clock: Clock }

export default defineMachine({
  name: 'SettingsMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { units: DEFAULT_UNITS, clock: DEFAULT_CLOCK } as Ctx,
  initial: 'ready',
  states: {
    ready: {
      on: {
        // The event's type says `Units`, but what arrives is JSON from a
        // browser, so the handler checks the value it was given.
        SET_UNITS: (ctx, ev) => {
          if (ev.units === 'metric' || ev.units === 'imperial') ctx.units = ev.units
        },
        SET_CLOCK: (ctx, ev) => {
          if (ev.clock === '12h' || ev.clock === '24h') ctx.clock = ev.clock
        },
      },
    },
  },
  selectors: {
    units: (ctx) => ctx.units,
    clock: (ctx) => ctx.clock,
  },
})
