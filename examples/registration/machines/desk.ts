import { defineMachine } from '@statorjs/stator/server'
import { cleanRegistration, seatsError } from '../lib/rules.ts'
import RosterMachine from './roster.ts'

type DeskContext = Record<string, never>

// The desk holds NO context — it is guards + emits, a pure routing layer.
// Two earlier cuts put state here and both were reclassified by use:
//
// `lastRegistered` (the "you're on the list" line) was a FLASH — an
// acknowledgement of a recent action. Session state survives refresh, so the
// message outlived its moment; and read-once flash semantics would need
// mutate-on-render, which the model forbids. An acknowledgement is view
// state: it lives in the form island's client machine and dies with the
// page, which is correct.
//
// Editing is NOT desk state — it's an address. An earlier cut held an
// `editing` snapshot here so an in-page arm flip could pre-fill the form; it
// meant the MODE survived refresh while the typing (uncontrolled inputs)
// didn't. The rule this taught: a mode earns machine residence only when
// guards or domain logic act on it (a checkout's states do); a mode with one
// render-region consumer belongs to the URL — /edit/:id owns it now.

type DeskEvents =
  | { type: 'REGISTER'; name: string; email: string; seats: number; ticket: string; updates?: boolean }
  | { type: 'UPDATE'; id: string; name: string; email: string; seats: number; ticket: string; updates?: boolean }
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
      payload: (_ctx: DeskContext, ev: { name: string; email: string; seats: number; ticket: string; updates?: boolean }) => {
        const clean = cleanRegistration(ev)
        // The guard already passed; clean cannot be null here.
        return clean ?? { name: '', email: '', seats: 0, ticket: 'general', updates: false }
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
    UPDATED: {
      payload: (_ctx: DeskContext, ev: { id: string; name: string; email: string; seats: number; ticket: string; updates?: boolean }) => {
        const clean = cleanRegistration(ev)
        return { id: ev.id, ...(clean ?? { name: '', email: '', seats: 0, ticket: 'general', updates: false }) }
      },
    },
  },

  context: {},
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
          emit: 'REGISTERED',
        },
        UPDATE: {
          when: (_ctx, ev, helpers) => {
            const clean = cleanRegistration(ev)
            if (!clean) return false
            const roster = helpers.reads.RosterMachine
            const current = roster.attendees.find((a) => a.id === ev.id)
            if (!current) return false
            if (roster.attendees.some((a) => a.id !== ev.id && a.email === clean.email))
              return false
            return roster.seatsTaken - current.seats + clean.seats <= roster.capacity
          },
          emit: 'UPDATED',
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

  selectors: {},
})

/** The roster's side of the relationship, wired from here — this file
 *  already imports roster.ts for `reads:`, and the reverse import would be a
 *  module cycle (see the note in roster.ts). */
RosterMachine.subscribes.push(
  { from: DeskMachine, event: 'REGISTERED', dispatch: 'RECORD' },
  { from: DeskMachine, event: 'SEATS_CHANGED', dispatch: 'RESIZE' },
  { from: DeskMachine, event: 'REMOVED', dispatch: 'DROP' },
  { from: DeskMachine, event: 'UPDATED', dispatch: 'AMEND' },
)

export default DeskMachine
