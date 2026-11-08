import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { matchOrigin } from '../src/server/origin-match.ts'

describe('matchOrigin', () => {
  describe('exact', () => {
    it('matches an identical origin', () => {
      assert.equal(matchOrigin('https://app.example.com', ['https://app.example.com']), true)
    })
    it('rejects a different host', () => {
      assert.equal(matchOrigin('https://evil.com', ['https://app.example.com']), false)
    })
    it('rejects a scheme mismatch', () => {
      assert.equal(matchOrigin('http://app.example.com', ['https://app.example.com']), false)
    })
    it('is case-insensitive on host', () => {
      assert.equal(matchOrigin('https://APP.Example.com', ['https://app.example.COM']), true)
    })
    it('a pattern without a port matches any port', () => {
      assert.equal(matchOrigin('http://localhost:3000', ['http://localhost']), true)
    })
    it('a pattern with a port requires that exact port', () => {
      assert.equal(matchOrigin('http://localhost:3000', ['http://localhost:4000']), false)
      assert.equal(matchOrigin('http://localhost:4000', ['http://localhost:4000']), true)
    })
  })

  describe('wildcard subdomain', () => {
    const pat = ['https://*.tonysull.co']
    it('matches a single-level subdomain', () => {
      assert.equal(matchOrigin('https://app.tonysull.co', pat), true)
    })
    it('matches a multi-level subdomain (any depth)', () => {
      assert.equal(matchOrigin('https://a.b.tonysull.co', pat), true)
    })
    it('does NOT match the apex', () => {
      assert.equal(matchOrigin('https://tonysull.co', pat), false)
    })
    it('rejects the suffix attack', () => {
      assert.equal(matchOrigin('https://tonysull.co.evil.com', pat), false)
    })
    it('rejects a non-boundary prefix', () => {
      assert.equal(matchOrigin('https://eviltonysull.co', pat), false)
    })
    it('rejects a scheme mismatch under wildcard', () => {
      assert.equal(matchOrigin('http://app.tonysull.co', pat), false)
    })
    it('honors an explicit port on the wildcard pattern', () => {
      assert.equal(
        matchOrigin('https://app.tonysull.co:8443', ['https://*.tonysull.co:8443']),
        true,
      )
      assert.equal(matchOrigin('https://app.tonysull.co', ['https://*.tonysull.co:8443']), false)
    })
    it('a wildcard without a port matches any port', () => {
      assert.equal(matchOrigin('https://app.tonysull.co:8443', pat), true)
    })
  })

  describe('robustness (fail closed)', () => {
    it('returns false for an empty/undefined/null origin', () => {
      assert.equal(matchOrigin(undefined, ['https://x.com']), false)
      assert.equal(matchOrigin(null, ['https://x.com']), false)
      assert.equal(matchOrigin('', ['https://x.com']), false)
    })
    it('returns false for a malformed origin', () => {
      assert.equal(matchOrigin('not a url', ['https://x.com']), false)
    })
    it('returns false against an empty allowlist', () => {
      assert.equal(matchOrigin('https://x.com', []), false)
    })
    it('matches if ANY pattern matches', () => {
      assert.equal(
        matchOrigin('https://app.tonysull.co', ['https://other.com', 'https://*.tonysull.co']),
        true,
      )
    })
    it('ignores a malformed pattern without throwing', () => {
      assert.equal(matchOrigin('https://x.com', ['::::bad', 'https://x.com']), true)
      assert.equal(matchOrigin('https://x.com', ['::::bad']), false)
    })
  })
})
