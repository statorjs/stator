import { defineMachine } from '@statorjs/stator/server'
import { discoverEndpoint, sendMention } from '../lib/webmention.ts'
import OwnerMachine from './owner.ts'

export type TargetStatus = 'sending' | 'sent' | 'no-endpoint' | 'failed'

export interface OutboxEntry {
  key: string
  postSlug: string
  sourceUrl: string
  target: string
  status: TargetStatus
  attempts: number
  lastAt: number
}

type OutboxContext = { entries: Record<string, OutboxEntry> }

type OutboxEvents =
  | { type: 'QUEUE'; postSlug: string; sourceUrl: string; target: string }
  | { type: 'SENT'; key: string }
  | { type: 'NO_ENDPOINT'; key: string }
  | { type: 'SEND_FAILED'; key: string }
  | { type: 'RETRY'; key: string }

/**
 * Outgoing webmentions — one entry per (post, target), each its own little
 * workflow: discover the target's endpoint, POST source+target, record what
 * happened. Syndication IS this machine: Bridgy publish endpoints are just
 * targets in the queue, so POSSE costs zero extra machinery.
 *
 * Retries are owner-triggered (a button in the admin panel), not automatic —
 * per-entry backoff timers want per-record `after`, which flat machines
 * don't have. That limit is logged as evidence in the paper-cut log.
 */
const OutboxMachine = defineMachine({
  name: 'OutboxMachine',
  lifecycle: 'app',
  persist: true,
  events: {} as OutboxEvents,

  subscribes: [
    { from: OwnerMachine, event: 'TARGET_QUEUED', dispatch: 'QUEUE' },
    { from: OwnerMachine, event: 'TARGET_RETRIED', dispatch: 'RETRY' },
  ],

  context: { entries: {} } as OutboxContext,
  initial: 'open',
  states: {
    open: {
      on: {
        QUEUE: {
          do: (ctx, ev) => {
            const key = `${ev.postSlug} → ${ev.target}`
            ctx.entries[key] = {
              key,
              postSlug: ev.postSlug,
              sourceUrl: ev.sourceUrl,
              target: ev.target,
              status: 'sending',
              attempts: (ctx.entries[key]?.attempts ?? 0) + 1,
              lastAt: Date.now(),
            }
          },
          effect: async (_ctx, ev): Promise<OutboxEvents> => {
            const key = `${ev.postSlug} → ${ev.target}`
            try {
              const endpoint = await discoverEndpoint(ev.target)
              if (!endpoint) return { type: 'NO_ENDPOINT', key }
              const ok = await sendMention(endpoint, ev.sourceUrl, ev.target)
              return ok ? { type: 'SENT', key } : { type: 'SEND_FAILED', key }
            } catch {
              return { type: 'SEND_FAILED', key }
            }
          },
        },
        RETRY: {
          when: (ctx, ev) => ctx.entries[ev.key]?.status === 'failed',
          do: (ctx, ev) => {
            const e = ctx.entries[ev.key]
            if (!e) return
            e.status = 'sending'
            e.attempts += 1
            e.lastAt = Date.now()
          },
          effect: async (ctx, ev): Promise<OutboxEvents | null> => {
            const e = ctx.entries[ev.key]
            if (!e) return null
            try {
              const endpoint = await discoverEndpoint(e.target)
              if (!endpoint) return { type: 'NO_ENDPOINT', key: ev.key }
              const ok = await sendMention(endpoint, e.sourceUrl, e.target)
              return ok ? { type: 'SENT', key: ev.key } : { type: 'SEND_FAILED', key: ev.key }
            } catch {
              return { type: 'SEND_FAILED', key: ev.key }
            }
          },
        },
      },
    },
  },

  // Completions at machine level — the collections-of-workflows rule.
  on: {
    SENT: (ctx, ev) => {
      const e = ctx.entries[ev.key]
      if (e) {
        e.status = 'sent'
        e.lastAt = Date.now()
      }
    },
    NO_ENDPOINT: (ctx, ev) => {
      const e = ctx.entries[ev.key]
      if (e) {
        e.status = 'no-endpoint'
        e.lastAt = Date.now()
      }
    },
    SEND_FAILED: (ctx, ev) => {
      const e = ctx.entries[ev.key]
      if (e) {
        e.status = 'failed'
        e.lastAt = Date.now()
      }
    },
  },

  selectors: {
    entries: (ctx) => Object.values(ctx.entries).sort((a, b) => b.lastAt - a.lastAt),
    failedCount: (ctx) =>
      Object.values(ctx.entries).filter((e) => e.status === 'failed').length,
  },
})

export default OutboxMachine
