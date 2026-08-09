/**
 * The shape rules — pure functions with no framework imports, so the SAME
 * rule runs on both tiers: the reg-form island calls them for instant
 * feedback, and the desk machine's guard calls them again before anything
 * commits. The server never trusts the client's copy.
 */

export const TICKETS = ['general', 'student', 'vip'] as const
export type Ticket = (typeof TICKETS)[number]

export const MAX_SEATS_PER_PARTY = 6

export function nameError(value: string): string | null {
  const name = value.trim()
  if (name.length < 2) return 'A name needs at least two characters.'
  if (name.length > 60) return 'Names fit in 60 characters.'
  return null
}

export function emailError(value: string): string | null {
  // Deliberately simple: something@something.tld. Real deliverability is a
  // send-a-mail problem, not a regex problem.
  const email = value.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That doesn't look like an email address."
  return null
}

export function seatsError(value: number): string | null {
  if (!Number.isInteger(value) || value < 1) return 'A party has at least one seat.'
  if (value > MAX_SEATS_PER_PARTY) return `Parties top out at ${MAX_SEATS_PER_PARTY} seats.`
  return null
}

export function ticketError(value: string): string | null {
  if (!(TICKETS as readonly string[]).includes(value)) return 'Pick a ticket type.'
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
  name: string
  email: string
  seats: number
  ticket: string
  updates?: boolean
}): Registration | null {
  if (nameError(raw.name) || emailError(raw.email) || seatsError(raw.seats)) return null
  if (ticketError(raw.ticket)) return null
  return {
    name: raw.name.trim(),
    email: raw.email.trim().toLowerCase(),
    seats: raw.seats,
    ticket: raw.ticket as Ticket,
    updates: raw.updates === true,
  }
}
