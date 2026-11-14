import { defineMachine } from '@statorjs/stator/machine'
import { geocode, type Place } from '../lib/open-meteo.ts'

/**
 * Location search. The input island dispatches `SEARCH` (debounced); a
 * transition effect geocodes the query server-side (keyless Open-Meteo, no CORS)
 * and feeds the results back as `RESULTS`.
 *
 * Picking a result is `PICK` with the result's position. The machine looks
 * the place up in its own results, clears the search, and emits `PICKED`
 * carrying it; `WeatherMachine` subscribes and adds it. The browser names a
 * row, and the server supplies what the row means.
 */

type Events =
  | { type: 'SEARCH'; query: string }
  | { type: 'RESULTS'; query: string; results: Place[] }
  | { type: 'PICK'; index: number }

interface Ctx {
  query: string
  results: Place[]
  searching: boolean
  /** The place the last `PICK` chose, for the `PICKED` payload. */
  picked: Place | null
}

export default defineMachine({
  name: 'SearchMachine',
  lifecycle: 'session',
  // The geocoding effect reports this; a browser may not.
  serverOnly: ['RESULTS'],
  events: {} as Events,
  emits: {
    // An emit's payload is computed after the handler ran, from the context
    // it left behind.
    PICKED: { payload: (ctx: Ctx) => ({ place: ctx.picked }) },
  },
  context: { query: '', results: [], searching: false, picked: null } as Ctx,
  initial: 'idle',
  states: {
    idle: {
      on: {
        SEARCH: {
          do: (ctx, ev) => {
            ctx.query = ev.query
            ctx.searching = ev.query.trim().length > 0
          },
          // Transition effect: geocode off the request path, feed results back.
          effect: async (_ctx, ev): Promise<Events | null> => {
            const query = ev.query.trim()
            if (!query) return { type: 'RESULTS', query: ev.query, results: [] }
            try {
              return { type: 'RESULTS', query: ev.query, results: await geocode(query) }
            } catch {
              return { type: 'RESULTS', query: ev.query, results: [] }
            }
          },
        },
        RESULTS: {
          // Ignore a stale response (the query moved on while it was in flight).
          do: (ctx, ev) => {
            if (ev.query !== ctx.query) return
            ctx.results = ev.results
            ctx.searching = false
          },
        },
        PICK: {
          when: (ctx, ev) => Number.isInteger(ev.index) && ev.index >= 0 && ev.index < ctx.results.length,
          do: (ctx, ev) => {
            ctx.picked = ctx.results[ev.index]!
            ctx.query = ''
            ctx.results = []
            ctx.searching = false
          },
          emit: 'PICKED',
        },
      },
    },
  },
  selectors: {
    query: (ctx) => ctx.query,
    results: (ctx) => ctx.results,
    hasResults: (ctx) => ctx.results.length > 0,
    searching: (ctx) => ctx.searching,
    // Distinguish "typed but nothing matched" from "haven't typed".
    empty: (ctx) => ctx.query.trim().length > 0 && !ctx.searching && ctx.results.length === 0,
  },
})
