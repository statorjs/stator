import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * scrypt via node:crypto — no dependency, deliberately synchronous. The
 * ~50ms of key derivation runs inside the request (and, for login, under
 * the session lock), which doubles as a natural brute-force throttle per
 * session.
 */

export function hashPassword(plaintext: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(plaintext, salt, 64).toString('hex')
  return { salt, hash }
}

export function verifyPassword(plaintext: string, salt: string, expectedHash: string): boolean {
  const actual = scryptSync(plaintext, salt, 64)
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
