import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * scrypt via node:crypto — no dependency. Deliberately SYNCHRONOUS so it can
 * run inside a machine guard (guards are sync by contract; that's what makes
 * "authenticate in the guard" possible). The trade-off: each derivation blocks
 * the event loop for ~25–50ms. That is NOT a brute-force defense — an attacker
 * uses a fresh cookieless session per guess, so it throttles nothing globally;
 * a production login needs real rate limiting (per-IP + per-account) on top.
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

// A fixed decoy so an unknown-email login still performs one scrypt derivation.
// Without it the missing derivation makes an unknown email return ~instantly
// while a known email takes ~25–50ms — a timing oracle that enumerates accounts.
const DECOY = hashPassword('decoy — never matches a real password')

/**
 * Verify a password against a user's stored credentials, or burn an equivalent
 * scrypt against the decoy when the user is unknown — so login response time
 * doesn't reveal whether the email exists. Always false on the decoy path.
 */
export function verifyPasswordConstantTime(
  plaintext: string,
  creds: { salt: string; hash: string } | undefined,
): boolean {
  const { salt, hash } = creds ?? DECOY
  const matched = verifyPassword(plaintext, salt, hash)
  return creds !== undefined && matched
}
