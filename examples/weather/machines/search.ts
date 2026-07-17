import { defineMachine } from '@statorjs/stator/server'
import WeatherMachine from './weather.ts'
import { geocode, type Place } from '../lib/open-meteo.ts'

/**
 * Location search. The input island dispatches `SEARCH` (debounced); a
 * transition effect geocodes the query server-side (keyless Open-Meteo, no CORS)
 * and feeds the results back as `RESULTS`. It `subscribes` to
 * `WeatherMachine.PLACE_ADDED` so picking a result — which adds it to the
 * Weather machine — also clears the search here, server-mediated.
 */

type Events =
  | { type: 'SEARCH'; query: string }
  | { type: 'RESULTS'; query: string; results: Place[] }
  | { type: 'CLEAR' }

interface Ctx {
  query: string
  results: Place[]
  searching: boolean
}

export default defineMachine({
  name: 'SearchMachine',
  lifecycle: 'session',
  events: {} as Events,
  subscribes: [{ from: WeatherMachine, event: 'PLACE_ADDED', dispatch: 'CLEAR' }],
  context: { query: '', results: [], searching: false } as Ctx,
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
        CLEAR: {
          do: (ctx) => {
            ctx.query = ''
            ctx.results = []
            ctx.searching = false
          },
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
