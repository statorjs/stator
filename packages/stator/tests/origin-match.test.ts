import { describe, expect, it } from 'vitest'
import { matchOrigin } from '../src/server/origin-match.ts'

describe('matchOrigin', () => {
  describe('exact', () => {
    it('matches an identical origin', () => {
      expect(matchOrigin('https://app.example.com', ['https://app.example.com'])).toBe(true)
    })
    it('rejects a different host', () => {
      expect(matchOrigin('https://evil.com', ['https://app.example.com'])).toBe(false)
    })
    it('rejects a scheme mismatch', () => {
      expect(matchOrigin('http://app.example.com', ['https://app.example.com'])).toBe(false)
    })
    it('is case-insensitive on host', () => {
      expect(matchOrigin('https://APP.Example.com', ['https://app.example.COM'])).toBe(true)
    })
    it('a pattern without a port matches any port', () => {
      expect(matchOrigin('http://localhost:3000', ['http://localhost'])).toBe(true)
    })
    it('a pattern with a port requires that exact port', () => {
      expect(matchOrigin('http://localhost:3000', ['http://localhost:4000'])).toBe(false)
      expect(matchOrigin('http://localhost:4000', ['http://localhost:4000'])).toBe(true)
    })
  })

  describe('wildcard subdomain', () => {
    const pat = ['https://*.tonysull.co']
    it('matches a single-level subdomain', () => {
      expect(matchOrigin('https://app.tonysull.co', pat)).toBe(true)
    })
    it('matches a multi-level subdomain (any depth)', () => {
      expect(matchOrigin('https://a.b.tonysull.co', pat)).toBe(true)
    })
    it('does NOT match the apex', () => {
      expect(matchOrigin('https://tonysull.co', pat)).toBe(false)
    })
    it('rejects the suffix attack', () => {
      expect(matchOrigin('https://tonysull.co.evil.com', pat)).toBe(false)
    })
    it('rejects a non-boundary prefix', () => {
      expect(matchOrigin('https://eviltonysull.co', pat)).toBe(false)
    })
    it('rejects a scheme mismatch under wildcard', () => {
      expect(matchOrigin('http://app.tonysull.co', pat)).toBe(false)
    })
    it('honors an explicit port on the wildcard pattern', () => {
      expect(matchOrigin('https://app.tonysull.co:8443', ['https://*.tonysull.co:8443'])).toBe(true)
      expect(matchOrigin('https://app.tonysull.co', ['https://*.tonysull.co:8443'])).toBe(false)
    })
    it('a wildcard without a port matches any port', () => {
      expect(matchOrigin('https://app.tonysull.co:8443', pat)).toBe(true)
    })
  })

  describe('robustness (fail closed)', () => {
    it('returns false for an empty/undefined/null origin', () => {
      expect(matchOrigin(undefined, ['https://x.com'])).toBe(false)
      expect(matchOrigin(null, ['https://x.com'])).toBe(false)
      expect(matchOrigin('', ['https://x.com'])).toBe(false)
    })
    it('returns false for a malformed origin', () => {
      expect(matchOrigin('not a url', ['https://x.com'])).toBe(false)
    })
    it('returns false against an empty allowlist', () => {
      expect(matchOrigin('https://x.com', [])).toBe(false)
    })
    it('matches if ANY pattern matches', () => {
      expect(
        matchOrigin('https://app.tonysull.co', ['https://other.com', 'https://*.tonysull.co']),
      ).toBe(true)
    })
    it('ignores a malformed pattern without throwing', () => {
      expect(matchOrigin('https://x.com', ['::::bad', 'https://x.com'])).toBe(true)
      expect(matchOrigin('https://x.com', ['::::bad'])).toBe(false)
    })
  })
})
