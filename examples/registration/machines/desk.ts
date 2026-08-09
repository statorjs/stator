import { defineMachine } from '@statorjs/stator/server'
import { cleanRegistration, seatsError } from '../lib/rules.ts'
import RosterMachine from './roster.ts'

type DeskContext = {
  /** Name from this session's last successful registration — powers the
   *  per-session "you're on the list" line. */
  lastRegistered: string | null
}

type DeskEvents =
  | { type: 'REGISTER'; name: string; email: string; seats: number; ticket: string }
  | { type: 'SET_SEATS'; id: string; seats: number }
  | { type: 'REMOVE'; id: string }

/**
 * The front desk — per-session. Client events land here; the shared roster
 * picks them up through its subscriptions. REGISTER commits ONLY when every
 * rule passes: the shape rules (the same functions the form ran in the
 * browser) and the truth rules the browser can't know — duplicates and
 * capacity — read live from the roster. A refused dispatch comes back
 * `committed: false` and the form keeps the visitor's typing.
 */
const DeskMachine = defineMachine({
  name: 'DeskMachine',
  lifecycle: 'session',
  events: {} as DeskEvents,
  reads: [RosterMachine],

  emits: {
    REGISTERED: {
      payload: (_ctx: DeskContext, ev: { name: string; email: string; seats: number; ticket: string }) => {
        const clean = cleanRegistration(ev)
        // The guard already passed; clean cannot be null here.
        return clean ?? { name: '', email: '', seats: 0, ticket: 'general' }
      },
    },
    SEATS_CHANGED: {
      payload: (_ctx: DeskContext, ev: { id: string; seats: number }) => ({
        id: ev.id,
        seats: ev.seats,
      }),
    },
    REMOVED: {
      payload: (_ctx: DeskContext, ev: { id: string }) => ({ id: ev.id }),
    },
  },

  context: { lastRegistered: null } as DeskContext,
  initial: 'open',
  states: {
    open: {
      on: {
        REGISTER: {
          when: (_ctx, ev, helpers) => {
            const clean = cleanRegistration(ev)
            if (!clean) return false
            const roster = helpers.reads.RosterMachine
            if (roster.attendees.some((a) => a.email === clean.email)) return false
            return roster.seatsTaken + clean.seats <= roster.capacity
          },
          do: (ctx, ev) => {
            ctx.lastRegistered = ev.name.trim()
          },
          emit: 'REGISTERED',
        },
        SET_SEATS: {
          when: (_ctx, ev, helpers) => {
            if (seatsError(ev.seats)) return false
            const roster = helpers.reads.RosterMachine
            const current = roster.attendees.find((a) => a.id === ev.id)
            if (!current) return false
            return roster.seatsTaken - current.seats + ev.seats <= roster.capacity
          },
          emit: 'SEATS_CHANGED',
        },
        REMOVE: {
          when: (_ctx, ev, helpers) =>
            helpers.reads.RosterMachine.attendees.some((a) => a.id === ev.id),
          emit: 'REMOVED',
        },
      },
    },
  },

  selectors: {
    lastRegistered: (ctx) => ctx.lastRegistered,
    hasRegistered: (ctx) => ctx.lastRegistered !== null,
  },
})

/** The roster's side of the relationship, wired from here — this file
 *  already imports roster.ts for `reads:`, and the reverse import would be a
 *  module cycle (see the note in roster.ts). */
RosterMachine.subscribes.push(
  { from: DeskMachine, event: 'REGISTERED', dispatch: 'RECORD' },
  { from: DeskMachine, event: 'SEATS_CHANGED', dispatch: 'RESIZE' },
  { from: DeskMachine, event: 'REMOVED', dispatch: 'DROP' },
)

export default DeskMachine
