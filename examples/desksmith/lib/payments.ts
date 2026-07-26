/**
 * Demo payment processor — deterministic by card suffix so every checkout
 * path is walkable from the UI:
 *   - '0000' declines,
 *   - '9999' never responds (the `after` rescue's demo trigger),
 *   - anything else succeeds after a beat.
 */
export async function chargeCard(
  last4: string,
  idempotencyKey: string,
): Promise<{ receipt: string }> {
  if (last4 === '9999') return new Promise(() => {}) // lost in the network, forever
  await new Promise((resolve) => setTimeout(resolve, 600))
  if (last4 === '0000') throw new Error('card declined')
  // Deriving the receipt from the idempotency key means a retried charge
  // yields the same order number — idempotent by construction.
  return { receipt: `ORD-${idempotencyKey.slice(0, 6).toUpperCase()}` }
}
