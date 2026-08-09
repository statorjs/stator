import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import RosterMachine, { CAPACITY } from '../machines/roster.ts'

/** The roster's arrival re-checks — the race-resolving half of the truth
 *  rules, tested without a server: events in, state out. */

const record = (name: string, email: string, seats = 1, ticket = 'general') => ({
  type: 'RECORD' as const,
  name,
  email,
  seats,
  ticket,
})

describe('the roster', () => {
  it('records a clean registration, normalized', () => {
    const actor = createActor(RosterMachine).start()
    actor.send(record(' Ada Lovelace ', ' Ada@Lovelace.DEV ', 2))
    const { attendees } = actor.getSnapshot().context
    expect(attendees).toHaveLength(1)
    expect(attendees[0]!.name).toBe('Ada Lovelace')
    expect(attendees[0]!.email).toBe('ada@lovelace.dev')
  })

  it('refuses a duplicate email, case-insensitively', () => {
    const actor = createActor(RosterMachine).start()
    actor.send(record('Ada', 'ada@lovelace.dev'))
    actor.send(record('Also Ada', 'ADA@lovelace.dev'))
    expect(actor.getSnapshot().context.attendees).toHaveLength(1)
  })

  it('refuses a registration that would blow the seat budget', () => {
    const actor = createActor(RosterMachine).start()
    for (let i = 0; i < CAPACITY / 6; i++) actor.send(record(`Party ${i}`, `p${i}@x.dev`, 6))
    actor.send(record('One More', 'more@x.dev', 1))
    const ctx = actor.getSnapshot().context
    expect(ctx.attendees.reduce((n, a) => n + a.seats, 0)).toBe(CAPACITY)
    expect(ctx.attendees.some((a) => a.email === 'more@x.dev')).toBe(false)
  })

  it('resizes within capacity, refuses past it', () => {
    const actor = createActor(RosterMachine).start()
    actor.send(record('Ada', 'ada@x.dev', 6))
    actor.send(record('Grace', 'grace@x.dev', 6))
    const id = actor.getSnapshot().context.attendees[0]!.id
    actor.send({ type: 'RESIZE', id, seats: 3 })
    expect(actor.getSnapshot().context.attendees[0]!.seats).toBe(3)
    // 3 + 6 taken of 24 — a resize to 30 is nonsense, to 6 is fine.
    actor.send({ type: 'RESIZE', id, seats: 30 })
    expect(actor.getSnapshot().context.attendees[0]!.seats).toBe(3)
  })

  it('drops an attendee and frees the seats', () => {
    const actor = createActor(RosterMachine).start()
    actor.send(record('Ada', 'ada@x.dev', 4))
    const id = actor.getSnapshot().context.attendees[0]!.id
    actor.send({ type: 'DROP', id })
    expect(actor.getSnapshot().context.attendees).toHaveLength(0)
  })
})
