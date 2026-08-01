/**
 * Stand-in for the datastore the admin edits — an in-memory table with a
 * per-record `version`, so saves are genuinely optimistic-concurrency-checked.
 *
 * It is module-level on purpose: two browser tabs share it, so a save in one
 * tab bumps the version and the other tab's stale save conflicts — a real
 * conflict without a real database. Latency is simulated so the async save
 * workflow (and its stranding hazard) is observable, not instantaneous.
 */

export type StockRecord = {
  id: string
  sku: string
  name: string
  quantity: number
  version: number
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const seed: StockRecord[] = [
  { id: 'r1', sku: 'DSK-001', name: 'Standing desk', quantity: 12, version: 1 },
  { id: 'r2', sku: 'CHR-014', name: 'Task chair', quantity: 40, version: 1 },
  { id: 'r3', sku: 'LMP-007', name: 'Desk lamp', quantity: 5, version: 1 },
  { id: 'r4', sku: 'MON-022', name: '27″ monitor', quantity: 18, version: 1 },
  { id: 'r5', sku: 'KBD-003', name: 'Mechanical keyboard', quantity: 0, version: 1 },
  { id: 'r6', sku: 'CAB-011', name: 'Cable tray', quantity: 63, version: 1 },
]

const table = new Map<string, StockRecord>(seed.map((r) => [r.id, { ...r }]))

/** Read the current stock. Slow enough that a refresh mid-save is easy to hit. */
export async function loadStock(): Promise<StockRecord[]> {
  await delay(600)
  return [...table.values()].map((r) => ({ ...r }))
}

export type CommitResult =
  | { ok: true; quantity: number; version: number }
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'conflict'; quantity: number; version: number }

/** Commit a new quantity for `id`, guarded by `baseVersion` (optimistic
 *  concurrency). A drifted version is a conflict, not a silent overwrite. */
export async function commitStock(
  id: string,
  quantity: number,
  baseVersion: number,
): Promise<CommitResult> {
  await delay(1200)
  if (!Number.isInteger(quantity) || quantity < 0) {
    return { ok: false, reason: 'invalid', message: 'Quantity must be a whole number ≥ 0' }
  }
  const current = table.get(id)
  if (!current) return { ok: false, reason: 'invalid', message: 'No such item' }
  if (current.version !== baseVersion) {
    return { ok: false, reason: 'conflict', quantity: current.quantity, version: current.version }
  }
  const next = { ...current, quantity, version: current.version + 1 }
  table.set(id, next)
  return { ok: true, quantity: next.quantity, version: next.version }
}

/** Delete a record. Synchronous — a demo delete has nothing to await, and doing
 *  it here (not just in the machine's view) keeps a later refresh consistent. */
export function removeStock(id: string): void {
  table.delete(id)
}
