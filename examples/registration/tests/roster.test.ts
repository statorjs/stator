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

  it('amends an attendee in place, keeping id and position', () => {
    const actor = createActor(RosterMachine).start()
    actor.send(record('Ada', 'ada@x.dev', 2))
    actor.send(record('Grace', 'grace@x.dev', 2))
    const id = actor.getSnapshot().context.attendees[0]!.id
    actor.send({ type: 'AMEND', id, name: 'Ada L.', email: 'ada@x.dev', seats: 3, ticket: 'vip' })
    const after = actor.getSnapshot().context.attendees[0]!
    expect(after).toMatchObject({ id, name: 'Ada L.', seats: 3, ticket: 'vip' })
  })

  it("refuses an amend onto another attendee's email", () => {
    const actor = createActor(RosterMachine).start()
    actor.send(record('Ada', 'ada@x.dev', 2))
    actor.send(record('Grace', 'grace@x.dev', 2))
    const id = actor.getSnapshot().context.attendees[0]!.id
    actor.send({ type: 'AMEND', id, name: 'Ada', email: 'GRACE@x.dev', seats: 2, ticket: 'general' })
    expect(actor.getSnapshot().context.attendees[0]!.email).toBe('ada@x.dev')
  })

  it('refuses an amend that would blow the seat budget', () => {
    const actor = createActor(RosterMachine).start()
    // 5+5+5+5+3 = 23 of 24. Growing the 3-seat party to 5 would make 25.
    for (let i = 0; i < 4; i++) actor.send(record(`Party ${i}`, `p${i}@x.dev`, 5))
    actor.send(record('Small', 'small@x.dev', 3))
    const small = actor.getSnapshot().context.attendees[4]!
    actor.send({ type: 'AMEND', id: small.id, name: 'Small', email: 'small@x.dev', seats: 5, ticket: 'general' })
    expect(actor.getSnapshot().context.attendees[4]!.seats).toBe(3)
    // Growing it to 4 (24 exactly) is fine.
    actor.send({ type: 'AMEND', id: small.id, name: 'Small', email: 'small@x.dev', seats: 4, ticket: 'general' })
    expect(actor.getSnapshot().context.attendees[4]!.seats).toBe(4)
  })

  it('drops an attendee and frees the seats', () => {
    const actor = createActor(RosterMachine).start()
    actor.send(record('Ada', 'ada@x.dev', 4))
    const id = actor.getSnapshot().context.attendees[0]!.id
    actor.send({ type: 'DROP', id })
    expect(actor.getSnapshot().context.attendees).toHaveLength(0)
  })
})
