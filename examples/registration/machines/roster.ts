import { defineMachine } from '@statorjs/stator/server'
import { cleanRegistration, seatsError } from '../lib/rules.ts'

export type Attendee = {
  id: string
  name: string
  email: string
  seats: number
  ticket: string
}

type RosterContext = { attendees: Attendee[]; capacity: number }

type RosterEvents =
  | { type: 'RECORD'; name: string; email: string; seats: number; ticket: string }
  | { type: 'AMEND'; id: string; name: string; email: string; seats: number; ticket: string }
  | { type: 'RESIZE'; id: string; seats: number }
  | { type: 'DROP'; id: string }

/** The whole event's seat budget. */
export const CAPACITY = 24

function genId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function seatsTaken(attendees: Attendee[]): number {
  return attendees.reduce((sum, a) => sum + a.seats, 0)
}

/**
 * The roster — one shared instance for every session, live on every open
 * desk. Sessions can't dispatch here directly: registrations arrive through
 * the desk's emits, and every rule runs AGAIN on arrival — two desks can
 * both pass their guards in the same instant, and the roster is where that
 * race resolves.
 */
export default defineMachine({
  name: 'RosterMachine',
  lifecycle: 'app',
  persist: true,
  events: {} as RosterEvents,

  // The desk→roster subscriptions live in desk.ts: declaring them here would
  // import desk.ts while desk.ts imports this file for `reads:` — a module
  // cycle the loader silently resolves to `undefined`. The importing end owns
  // the wiring (the cart↔inventory precedent in apps/store).

  context: { attendees: [], capacity: CAPACITY } as RosterContext,
  initial: 'open',
  states: {
    open: {
      on: {
        RECORD: (ctx, ev) => {
          const clean = cleanRegistration(ev)
          if (!clean) return
          if (ctx.attendees.some((a) => a.email === clean.email)) return
          if (seatsTaken(ctx.attendees) + clean.seats > ctx.capacity) return
          ctx.attendees.push({ id: genId(), ...clean })
        },
        AMEND: (ctx, ev) => {
          const attendee = ctx.attendees.find((a) => a.id === ev.id)
          const clean = cleanRegistration(ev)
          if (!attendee || !clean) return
          if (ctx.attendees.some((a) => a.id !== ev.id && a.email === clean.email)) return
          if (seatsTaken(ctx.attendees) - attendee.seats + clean.seats > ctx.capacity) return
          // Replace fields in place — the row keeps its id and position, so
          // the keyed list patches the row instead of reordering it.
          Object.assign(attendee, clean)
        },
        RESIZE: (ctx, ev) => {
          const attendee = ctx.attendees.find((a) => a.id === ev.id)
          if (!attendee || seatsError(ev.seats)) return
          if (seatsTaken(ctx.attendees) - attendee.seats + ev.seats > ctx.capacity) return
          attendee.seats = ev.seats
        },
        DROP: (ctx, ev) => {
          const at = ctx.attendees.findIndex((a) => a.id === ev.id)
          if (at !== -1) ctx.attendees.splice(at, 1)
        },
      },
    },
  },

  selectors: {
    attendees: (ctx) => ctx.attendees,
    count: (ctx) => ctx.attendees.length,
    seatsTaken: (ctx) => seatsTaken(ctx.attendees),
    seatsLeft: (ctx) => ctx.capacity - seatsTaken(ctx.attendees),
    capacity: (ctx) => ctx.capacity,
    isFull: (ctx) => seatsTaken(ctx.attendees) >= ctx.capacity,
  },
})
