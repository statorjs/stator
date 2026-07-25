/** The book's rules, in one place. Both machines apply them — the visitor
 *  machine before emitting, the book machine before recording — so there is
 *  no path into the book that skips them. The form's maxlength is a
 *  courtesy, not the enforcement. */

export const MAX_NAME = 60
export const MAX_MESSAGE = 280

export type Signature = { name: string; message: string }

/** A valid signature, cleaned — or null if the rules say no. */
export function cleanSignature(rawName: unknown, rawMessage: unknown): Signature | null {
  const name = String(rawName ?? '')
    .trim()
    .slice(0, MAX_NAME)
  const message = String(rawMessage ?? '').trim()
  if (!name || !message || message.length > MAX_MESSAGE) return null
  return { name, message }
}
