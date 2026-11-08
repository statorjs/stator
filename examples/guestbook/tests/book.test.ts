import { createActor } from '@statorjs/stator/machine'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
    assert.equal(entries.length, 2)
    assert.equal(entries[0]!.name, 'Ketil')
    assert.equal(entries[1]!.name, 'Marisol')
    assert.equal(entries[1]!.message, 'The web needed more guestbooks back.')
  })

  it('refuses a nameless or empty signature', () => {
    const actor = createActor(BookMachine).start()
    actor.send(sign('   ', 'no name attached'))
    actor.send(sign('A Name', '   '))
    assert.equal((actor.getSnapshot().context.entries).length, 0)
  })

  it('refuses a message over 280 characters', () => {
    const actor = createActor(BookMachine).start()
    actor.send(sign('Longwind', 'x'.repeat(281)))
    assert.equal((actor.getSnapshot().context.entries).length, 0)
  })

  it('keeps only the latest signatures', () => {
    const actor = createActor(BookMachine).start()
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      actor.send(sign(`Visitor ${i}`, `note ${i}`))
    }
    const { entries } = actor.getSnapshot().context
    assert.equal(entries.length, MAX_ENTRIES)
    assert.equal(entries[0]!.name, `Visitor ${MAX_ENTRIES + 4}`)
  })
})

describe('the visitor', () => {
  it('counts only signatures the rules accept', () => {
    const actor = createActor(VisitorMachine).start()
    actor.send({ type: 'SIGN', name: 'June', message: 'hello' })
    actor.send({ type: 'SIGN', name: '', message: 'anonymous drive-by' })
    assert.equal(actor.getSnapshot().context.signedCount, 1)
  })
})
