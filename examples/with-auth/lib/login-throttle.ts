/**
 * Per-account login throttle: after MAX_FAILURES wrong passwords for one
 * email within WINDOW_MS, further attempts are refused before the password
 * is checked, so a guessing loop costs no scrypt work. A success clears it.
 *
 * In memory, so it resets on restart and covers one process. A production
 * login also limits per IP at the proxy, which this does not see.
 */
const MAX_FAILURES = 5
const WINDOW_MS = 15 * 60_000

const failures = new Map<string, { count: number; since: number }>()

const keyOf = (email: string): string => email.trim().toLowerCase()

export function isLocked(email: string, now = Date.now()): boolean {
  const entry = failures.get(keyOf(email))
  if (!entry) return false
  if (now - entry.since > WINDOW_MS) {
    failures.delete(keyOf(email))
    return false
  }
  return entry.count >= MAX_FAILURES
}

export function recordFailure(email: string, now = Date.now()): void {
  const key = keyOf(email)
  const entry = failures.get(key)
  if (!entry || now - entry.since > WINDOW_MS) failures.set(key, { count: 1, since: now })
  else entry.count++
}

export function clearFailures(email: string): void {
  failures.delete(keyOf(email))
}
