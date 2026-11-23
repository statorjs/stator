/**
 * Guard for a reload the server asked for as a remedy (a build or layout
 * mismatch). The remedy fails when a cache hands the same page back, so the
 * attempt is remembered across the reload and a repeat waits before retrying.
 */

const KEY = 'stator:reload'
const DELAYS_MS = [0, 5_000, 15_000, 30_000, 60_000]
const MAX_AGE_MS = 10 * 60_000

/**
 * Reload now on the first mismatch for this path, reason and token; on a
 * repeat, call `hold` with the delay to wait before the next reload.
 */
export function guardedReload(
  reason: 'build' | 'layout',
  token: string,
  hold: (delayMs: number) => void,
): void {
  const path = location.pathname
  let count = 0
  try {
    const prev = JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
    if (
      prev &&
      prev.path === path &&
      prev.reason === reason &&
      prev.token === token &&
      Date.now() - prev.at < MAX_AGE_MS
    ) {
      count = prev.count
    }
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ path, reason, token, count: count + 1, at: Date.now() }),
    )
  } catch {
    // No usable storage: a document that was itself loaded by a reload has
    // already tried once.
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined
    count = nav?.type === 'reload' ? 1 : 0
  }
  const delay = DELAYS_MS[Math.min(count, DELAYS_MS.length - 1)]!
  if (delay === 0) location.reload()
  else hold(delay)
}

export function clearReloadGuard(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // nothing was stored
  }
}
