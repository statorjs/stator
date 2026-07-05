/**
 * The fake payment provider: latency, deterministic outcomes by token, and
 * real idempotency by key — so the checkout effect can demonstrate the whole
 * pending → settled arc (including declines and at-most-once retries)
 * without a payments account. In-process by design; a deploy resets it.
 */

export interface ChargeRequest {
  token: string
  amountCents: number
  idempotencyKey: string
}

export type ChargeResult = { ok: true; receiptId: string } | { ok: false; reason: string }

/** Tokens the review form offers. */
export const CARD_TOKENS = {
  ok: 'tok_ok',
  declined: 'tok_declined',
} as const

const settled = new Map<string, ChargeResult>()

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function chargeCard(req: ChargeRequest): Promise<ChargeResult> {
  // Idempotency first: a retried key settles identically, with no new charge.
  const prior = settled.get(req.idempotencyKey)
  if (prior) return prior

  await sleep(400 + Math.random() * 600) // the bank thinks about it

  const result: ChargeResult =
    req.token === CARD_TOKENS.declined
      ? { ok: false, reason: 'The Kraken Card was declined, as it always is.' }
      : req.amountCents <= 0
        ? { ok: false, reason: 'Nothing to charge.' }
        : { ok: true, receiptId: `rcpt_${req.idempotencyKey.slice(0, 8)}` }

  settled.set(req.idempotencyKey, result)
  return result
}
