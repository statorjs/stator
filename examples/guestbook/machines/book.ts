import { defineMachine } from '@statorjs/stator/server'
import { cleanSignature } from '../lib/rules.ts'
import VisitorMachine from './visitor.ts'

export type Entry = {
  id: string
  name: string
  message: string
  signedAt: number
}

type BookContext = { entries: Entry[] }

type BookEvents = {
  type: 'RECORD_SIGNATURE'
  name: string
  message: string
  /** Injected by the cross-lifecycle delivery path. Not stored — entries are
   *  public, sessions are not. */
  sourceSessionId: string
}

/** The book keeps its latest signatures; older ones fall off the end. */
export const MAX_ENTRIES = 100

function genId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** The shared book — one instance for every visitor, persisted across
 *  restarts. Sessions can't dispatch here directly; signatures arrive through
 *  the subscription below, and the rules run again on arrival. */
export default defineMachine({
  name: 'BookMachine',
  lifecycle: 'app',
  persist: true,
  events: {} as BookEvents,

  subscribes: [{ from: VisitorMachine, event: 'SIGNED', dispatch: 'RECORD_SIGNATURE' }],

  context: { entries: [] } as BookContext,
  initial: 'open',
  states: {
    open: {
      on: {
        RECORD_SIGNATURE: (ctx, ev) => {
          const sig = cleanSignature(ev.name, ev.message)
          if (!sig) return
          ctx.entries.unshift({
            id: genId(),
            name: sig.name,
            message: sig.message,
            signedAt: Date.now(),
          })
          if (ctx.entries.length > MAX_ENTRIES) ctx.entries.length = MAX_ENTRIES
        },
      },
    },
  },

  selectors: {
    entries: (ctx) => ctx.entries,
    count: (ctx) => ctx.entries.length,
  },
})
