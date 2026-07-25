import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import BookMachine, { MAX_ENTRIES } from '../machines/book.ts'
import VisitorMachine from '../machines/visitor.ts'

/** The book's rules, tested without a browser — events in, state out. */

const sign = (name: string, message: string) => ({
  type: 'RECORD_SIGNATURE' as const,
  name,
  message,
  sourceSessionId: 's-test',
})

describe('the book', () => {
  it('records a signature, newest first, trimmed', () => {
    const actor = createActor(BookMachine).start()
    actor.send(sign('  Marisol  ', '  The web needed more guestbooks back.  '))
    actor.send(sign('Ketil', 'Signing from a train outside Bergen.'))
    const { entries } = actor.getSnapshot().context
    expect(entries).toHaveLength(2)
    expect(entries[0]!.name).toBe('Ketil')
    expect(entries[1]!.name).toBe('Marisol')
    expect(entries[1]!.message).toBe('The web needed more guestbooks back.')
  })

  it('refuses a nameless or empty signature', () => {
    const actor = createActor(BookMachine).start()
    actor.send(sign('   ', 'no name attached'))
    actor.send(sign('A Name', '   '))
    expect(actor.getSnapshot().context.entries).toHaveLength(0)
  })

  it('refuses a message over 280 characters', () => {
    const actor = createActor(BookMachine).start()
    actor.send(sign('Longwind', 'x'.repeat(281)))
    expect(actor.getSnapshot().context.entries).toHaveLength(0)
  })

  it('keeps only the latest signatures', () => {
    const actor = createActor(BookMachine).start()
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      actor.send(sign(`Visitor ${i}`, `note ${i}`))
    }
    const { entries } = actor.getSnapshot().context
    expect(entries).toHaveLength(MAX_ENTRIES)
    expect(entries[0]!.name).toBe(`Visitor ${MAX_ENTRIES + 4}`)
  })
})

describe('the visitor', () => {
  it('counts only signatures the rules accept', () => {
    const actor = createActor(VisitorMachine).start()
    actor.send({ type: 'SIGN', name: 'June', message: 'hello' })
    actor.send({ type: 'SIGN', name: '', message: 'anonymous drive-by' })
    expect(actor.getSnapshot().context.signedCount).toBe(1)
  })
})
