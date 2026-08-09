import { describe, expect, it } from 'vitest'
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
    expect(nameError(' A ')).toBeTruthy()
    expect(nameError('Al')).toBeNull()
  })
  it('caps at 60', () => {
    expect(nameError('x'.repeat(61))).toBeTruthy()
    expect(nameError('x'.repeat(60))).toBeNull()
  })
})

describe('emailError', () => {
  it('wants something@something.tld', () => {
    expect(emailError('nope')).toBeTruthy()
    expect(emailError('a@b')).toBeTruthy()
    expect(emailError('ada@lovelace.dev')).toBeNull()
  })
})

describe('seatsError', () => {
  it('wants an integer between 1 and the party max', () => {
    expect(seatsError(0)).toBeTruthy()
    expect(seatsError(2.5)).toBeTruthy()
    expect(seatsError(Number.NaN)).toBeTruthy()
    expect(seatsError(MAX_SEATS_PER_PARTY + 1)).toBeTruthy()
    expect(seatsError(1)).toBeNull()
    expect(seatsError(MAX_SEATS_PER_PARTY)).toBeNull()
  })
})

describe('ticketError', () => {
  it('only knows the three ticket types', () => {
    expect(ticketError('vip')).toBeNull()
    expect(ticketError('backstage')).toBeTruthy()
  })
})

describe('cleanRegistration', () => {
  it('normalizes: trimmed name, lowercased email', () => {
    const clean = cleanRegistration({
      name: '  Ada Lovelace ',
      email: ' Ada@Lovelace.DEV ',
      seats: 2,
      ticket: 'general',
    })
    expect(clean).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@lovelace.dev',
      seats: 2,
      ticket: 'general',
    })
  })
  it('refuses when any shape rule fails', () => {
    expect(cleanRegistration({ name: 'A', email: 'a@b.c', seats: 1, ticket: 'vip' })).toBeNull()
    expect(cleanRegistration({ name: 'Ada', email: 'nope', seats: 1, ticket: 'vip' })).toBeNull()
    expect(cleanRegistration({ name: 'Ada', email: 'a@b.c', seats: 9, ticket: 'vip' })).toBeNull()
    expect(cleanRegistration({ name: 'Ada', email: 'a@b.c', seats: 1, ticket: 'nope' })).toBeNull()
  })
})
