import type { InstanceOf } from '@statorjs/stator/template'
import type PollsMachine from '../machines/polls.ts'

export type PollOption = { id: string; text: string; count: number }
export type Poll = {
  id: string
  question: string
  options: PollOption[]
  createdAt: number
}

/** Look up a poll by id through the machine's curried `byId` selector. The cast
 *  bridges the selector's loose typing — a keyed lookup that returns a function.
 *  (That cast is itself a small tell: curried find-by-id selectors want cleaner
 *  types, and longer-term, first-class per-record addressing.) */
export const pollOf = (polls: InstanceOf<typeof PollsMachine>, pollId: string): Poll | undefined =>
  (polls.byId as (id: string) => Poll | undefined)(pollId)
