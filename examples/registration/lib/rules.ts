/**
 * The shape rules — pure functions with no framework imports, so the SAME
 * rule runs on both tiers: the reg-form island calls them for instant
 * feedback, and the desk machine's guard calls them again before anything
 * commits. The server never trusts the client's copy.
 */

export const TICKETS = ['general', 'student', 'vip'] as const
export type Ticket = (typeof TICKETS)[number]

export const MAX_SEATS_PER_PARTY = 6

// Each rule takes `unknown`: on the server, its input is JSON from a browser.

export function nameError(value: unknown): string | null {
  if (typeof value !== 'string') return 'A name needs at least two characters.'
  const name = value.trim()
  if (name.length < 2) return 'A name needs at least two characters.'
  if (name.length > 60) return 'Names fit in 60 characters.'
  return null
}

export function emailError(value: unknown): string | null {
  if (typeof value !== 'string') return "That doesn't look like an email address."
  // Deliberately simple: something@something.tld. Real deliverability is a
  // send-a-mail problem, not a regex problem.
  const email = value.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That doesn't look like an email address."
  return null
}

export function seatsError(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return 'A party has at least one seat.'
  if (value > MAX_SEATS_PER_PARTY) return `Parties top out at ${MAX_SEATS_PER_PARTY} seats.`
  return null
}

export function ticketError(value: unknown): string | null {
  if (typeof value !== 'string' || !(TICKETS as readonly string[]).includes(value)) return 'Pick a ticket type.'
  return null
}

export type Registration = {
  name: string
  email: string
  seats: number
  ticket: Ticket
  /** Marketing opt-in — optional by nature, so it carries no rule; it rides
   *  the clean shape as a plain boolean (absent = false). */
  updates: boolean
}

/** Normalize a raw submission, or refuse it: trimmed name, lowercased email,
 *  every shape rule passed. One function, called by the island, the desk
 *  guard, and the roster's arrival re-check. */
export function cleanRegistration(raw: {
  name: unknown
  email: unknown
  seats: unknown
  ticket: unknown
  updates?: unknown
}): Registration | null {
  const { name, email, seats, ticket } = raw
  if (nameError(name) || emailError(email) || seatsError(seats) || ticketError(ticket)) return null
  if (typeof name !== 'string' || typeof email !== 'string' || typeof seats !== 'number') return null
  return {
    name: name.trim(),
    email: email.trim().toLowerCase(),
    seats,
    ticket: ticket as Ticket,
    updates: raw.updates === true,
  }
}
