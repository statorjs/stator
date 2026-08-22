import type { AnyMachineDef, Snapshot } from '../engine/index.ts'
import { scopedLogger } from './logger.ts'
import { codeHashOf } from './machine-hash.ts'

/**
 * Snapshot hydration policy — "sessions never outlive the code that made them"
 * (spec `machine-state-is-working-state-snapshot-hydration-policy`).
 *
 * The host stamps every persisted snapshot with the snapshot `format` and the
 * writing machine's code hash (`stampSnapshot`), and reconciles a persisted
 * snapshot against the running def before building an actor
 * (`reconcileSnapshot`): a snapshot written by different code, in a newer
 * format, or naming a state the chart no longer has, is discarded and the
 * machine starts fresh — identically in dev and prod, for any Store.
 *
 * Resets are logged at `warn`, rate-limited per machine per process (first
 * occurrence, then every power of ten) so a deploy across a large store stays
 * visible without flooding.
 */

/** The current persisted-snapshot format. Bump when the shape changes. */
export const SNAPSHOT_FORMAT = 1

const log = scopedLogger('hydrate')

export type ResetReason = 'code-changed' | 'format-newer' | 'state-missing' | 'shape-invalid'

/** Stamp a snapshot for persistence with the format and the def's code hash.
 *  A def with no registered hash (a store assembled from defs directly, not
 *  via discovery) stamps no hash — and is never reset for it. */
export function stampSnapshot<C>(
  def: AnyMachineDef | undefined,
  snapshot: Snapshot<C>,
): Snapshot<C> {
  const code = def ? codeHashOf(def) : undefined
  return { ...snapshot, format: SNAPSHOT_FORMAT, ...(code ? { code } : {}) }
}

/** Why a persisted snapshot cannot be hydrated under `def`, or null if it can. */
export function snapshotResetReason(def: AnyMachineDef, persisted: unknown): ResetReason | null {
  const snap = persisted as Partial<Snapshot<unknown>> | null
  if (
    !snap ||
    typeof snap !== 'object' ||
    !Array.isArray(snap.value) ||
    typeof snap.context !== 'object' ||
    snap.context === null
  ) {
    return 'shape-invalid'
  }
  if ((snap.format ?? SNAPSHOT_FORMAT) > SNAPSHOT_FORMAT) return 'format-newer'
  const expected = codeHashOf(def)
  if (expected !== undefined && snap.code !== expected) return 'code-changed'
  const state = snap.value[0]
  if (state === undefined || !(state in def.states)) return 'state-missing'
  return null
}

/**
 * The persisted snapshot to hydrate from, or `undefined` to start fresh.
 * `null` persisted (nothing stored) is a fresh start with no log; a stored
 * snapshot that cannot be used is a reset, logged.
 */
export function reconcileSnapshot(
  def: AnyMachineDef,
  persisted: unknown,
  scope: string,
): Snapshot<object> | undefined {
  if (persisted === null || persisted === undefined) return undefined
  const reason = snapshotResetReason(def, persisted)
  if (reason === null) return persisted as Snapshot<object>
  logReset(def, persisted as Partial<Snapshot<unknown>>, reason, scope)
  return undefined
}

const resetCounts = new Map<string, number>()

function logReset(
  def: AnyMachineDef,
  snap: Partial<Snapshot<unknown>>,
  reason: ResetReason,
  scope: string,
): void {
  const n = (resetCounts.get(def.name) ?? 0) + 1
  resetCounts.set(def.name, n)
  // 1, 10, 100, 1000, … — the first reset is the news; the count is the scale.
  if (n !== 1 && !Number.isInteger(Math.log10(n))) return
  log.warn(
    {
      machine: def.name,
      scope,
      reason,
      resets: n,
      ...(reason === 'code-changed' ? { from: snap.code ?? null, to: codeHashOf(def) } : {}),
      ...(reason === 'state-missing' ? { state: snap.value?.[0] ?? null } : {}),
    },
    reason === 'code-changed'
      ? 'machine code changed since this snapshot was written — starting fresh'
      : reason === 'format-newer'
        ? 'snapshot written in a newer format than this server understands — starting fresh'
        : reason === 'state-missing'
          ? 'snapshot names a state the machine no longer has — starting fresh'
          : 'persisted snapshot has an invalid shape — starting fresh',
  )
}

/** Test hook: forget rate-limit counts. */
export function resetSnapshotPolicyCounters(): void {
  resetCounts.clear()
}
