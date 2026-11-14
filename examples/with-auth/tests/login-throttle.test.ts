import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clearFailures, isLocked, recordFailure } from '../lib/login-throttle.ts'

describe('login throttle', () => {
  it('locks an account after five failures, case-insensitively', () => {
    const now = 1_000_000
    for (let i = 0; i < 4; i++) recordFailure('Pat@Quay.test', now)
    assert.equal(isLocked('pat@quay.test', now), false)
    recordFailure('pat@quay.test', now)
    assert.equal(isLocked('PAT@quay.test', now), true)
  })

  it('unlocks once the window has passed', () => {
    const now = 2_000_000
    for (let i = 0; i < 5; i++) recordFailure('sam@quay.test', now)
    assert.equal(isLocked('sam@quay.test', now + 15 * 60_000 + 1), false)
  })

  it('a success clears the count', () => {
    for (let i = 0; i < 4; i++) recordFailure('kim@quay.test')
    clearFailures('kim@quay.test')
    recordFailure('kim@quay.test')
    assert.equal(isLocked('kim@quay.test'), false)
  })
})
