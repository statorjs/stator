import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cleanRegistration,
  emailError,
  MAX_SEATS_PER_PARTY,
  nameError,
  seatsError,
  ticketError,
} from '../lib/rules.ts'

/** The shape rules — one pure module, exercised once, trusted on both tiers. */

describe('nameError', () => {
  it('wants two characters, trims first', () => {
    assert.ok(nameError(' A '))
    assert.equal(nameError('Al'), null)
  })
  it('caps at 60', () => {
    assert.ok(nameError('x'.repeat(61)))
    assert.equal(nameError('x'.repeat(60)), null)
  })
})

describe('emailError', () => {
  it('wants something@something.tld', () => {
    assert.ok(emailError('nope'))
    assert.ok(emailError('a@b'))
    assert.equal(emailError('ada@lovelace.dev'), null)
  })
})

describe('seatsError', () => {
  it('wants an integer between 1 and the party max', () => {
    assert.ok(seatsError(0))
    assert.ok(seatsError(2.5))
    assert.ok(seatsError(Number.NaN))
    assert.ok(seatsError(MAX_SEATS_PER_PARTY + 1))
    assert.equal(seatsError(1), null)
    assert.equal(seatsError(MAX_SEATS_PER_PARTY), null)
  })
})

describe('ticketError', () => {
  it('only knows the three ticket types', () => {
    assert.equal(ticketError('vip'), null)
    assert.ok(ticketError('backstage'))
  })
})

describe('cleanRegistration', () => {
  it('normalizes: trimmed name, lowercased email, updates defaulting false', () => {
    const clean = cleanRegistration({
      name: '  Ada Lovelace ',
      email: ' Ada@Lovelace.DEV ',
      seats: 2,
      ticket: 'general',
    })
    assert.deepStrictEqual(clean, {
      name: 'Ada Lovelace',
      email: 'ada@lovelace.dev',
      seats: 2,
      ticket: 'general',
      updates: false,
    })
    assert.equal(cleanRegistration({ name: 'Ada', email: 'a@b.c', seats: 1, ticket: 'vip', updates: true })!
        .updates, true)
  })
  it('refuses when any shape rule fails', () => {
    assert.equal(cleanRegistration({ name: 'A', email: 'a@b.c', seats: 1, ticket: 'vip' }), null)
    assert.equal(cleanRegistration({ name: 'Ada', email: 'nope', seats: 1, ticket: 'vip' }), null)
    assert.equal(cleanRegistration({ name: 'Ada', email: 'a@b.c', seats: 9, ticket: 'vip' }), null)
    assert.equal(cleanRegistration({ name: 'Ada', email: 'a@b.c', seats: 1, ticket: 'nope' }), null)
  })
})
