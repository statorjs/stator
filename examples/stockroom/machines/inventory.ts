import { defineMachine } from '@statorjs/stator/server'
import { commitStock, loadStock, type StockRecord } from '../lib/inventory-source.ts'

/**
 * Editable inventory collection. It has TWO independent state axes:
 *
 *   1. a machine-wide freshness axis — is my snapshot loaded? (`loading` / `ready`)
 *   2. a per-record save workflow    — each row: clean → saving → clean | conflict | failed
 *
 * A flat machine can put only ONE axis in its `states`. This one puts freshness
 * in the chart and pushes the per-record workflow into `context` (`ctx.saves`), a
 * phase string per id. Building it this way surfaced two things (see FINDINGS):
 *
 *   - Stranded completions — RESOLVED with machine-level `on:`. The save
 *     completions (SAVE_OK/CONFLICT/FAILED) are handled at the machine level
 *     (see the `on:` block below `states`), so a completion arriving while the
 *     machine is `loading` (a REFRESH fired mid-save) is still handled — not
 *     dropped. Before that primitive, a state-scoped handler in `ready` was the
 *     only option and the row stranded in `saving` on a mid-save refresh.
 *   - The per-record workflow — where the interesting states (conflict/failed)
 *     and their retries live — is still invisible in the chart: it is a phase
 *     string in a context map, not a chart the framework can audit. Machine-level
 *     `on:` fixes the drop, not this. That gap motivates the child/family-machine
 *     composition direction (a per-record workflow as its own machine).
 */

type Row = {
  id: string
  sku: string
  name: string
  onHand: number // last committed quantity
  draft: number // edited (optimistic) quantity
  version: number
}

type SavePhase = 'clean' | 'saving' | 'conflict' | 'failed'
type SaveState = { phase: SavePhase; message: string }

type InventoryContext = {
  rows: Row[]
  loadedAt: string
  loadError: string
  saves: Record<string, SaveState>
}

type InventoryEvents =
  | { type: 'LOADED'; rows: StockRecord[] }
  | { type: 'LOAD_FAILED'; message: string }
  | { type: 'REFRESH' }
  | { type: 'ADJUST'; id: string; delta: number }
  | { type: 'SAVE'; id: string }
  | { type: 'SAVE_OK'; id: string; quantity: number; version: number }
  | { type: 'SAVE_CONFLICT'; id: string; quantity: number; version: number }
  | { type: 'SAVE_FAILED'; id: string; message: string }

const cleanSaves = (rows: Row[]): Record<string, SaveState> =>
  Object.fromEntries(rows.map((r) => [r.id, { phase: 'clean' as const, message: '' }]))

export default defineMachine({
  name: 'InventoryMachine',
  lifecycle: 'session',
  events: {} as InventoryEvents,
  context: { rows: [], loadedAt: '', loadError: '', saves: {} } as InventoryContext,

  initial: 'loading',
  states: {
    loading: {
      // Load role: entry effect fetches current stock, re-invoked on hydration.
      entry: async (): Promise<InventoryEvents> => {
        try {
          return { type: 'LOADED', rows: await loadStock() }
        } catch (err) {
          return { type: 'LOAD_FAILED', message: String(err) }
        }
      },
      on: {
        LOADED: {
          to: 'ready',
          do: (ctx, ev) => {
            ctx.rows = ev.rows.map((r) => ({ ...r, onHand: r.quantity, draft: r.quantity }))
            ctx.loadedAt = new Date().toISOString()
            ctx.loadError = ''
            ctx.saves = cleanSaves(ctx.rows)
          },
        },
        LOAD_FAILED: {
          to: 'ready',
          do: (ctx, ev) => {
            ctx.loadError = ev.message
          },
        },
      },
    },

    ready: {
      on: {
        REFRESH: { to: 'loading' },

        // Relative adjust (not an absolute set): the delta lets the machine own
        // the arithmetic against the CURRENT draft, so a stepper button never
        // sends a stale render-time value.
        ADJUST: {
          do: (ctx, ev) => {
            const row = ctx.rows.find((r) => r.id === ev.id)
            if (row) row.draft = Math.max(0, row.draft + ev.delta)
          },
        },

        // Per-record save: a COMMAND-role transition effect (at-most-once). Stays
        // in `ready` — you can keep editing other rows while one saves.
        SAVE: {
          when: (ctx, ev) => {
            const s = ctx.saves[ev.id]
            return !!s && s.phase !== 'saving' // no double-submit
          },
          do: (ctx, ev) => {
            ctx.saves[ev.id] = { phase: 'saving', message: '' }
          },
          effect: async (ctx, ev): Promise<InventoryEvents> => {
            const row = ctx.rows.find((r) => r.id === ev.id)
            if (!row) return { type: 'SAVE_FAILED', id: ev.id, message: 'No such row' }
            const res = await commitStock(ev.id, row.draft, row.version)
            if (res.ok) {
              return { type: 'SAVE_OK', id: ev.id, quantity: res.quantity, version: res.version }
            }
            if (res.reason === 'conflict') {
              return { type: 'SAVE_CONFLICT', id: ev.id, quantity: res.quantity, version: res.version }
            }
            return { type: 'SAVE_FAILED', id: ev.id, message: res.message }
          },
        },
      },
    },
  },

  // The per-record save completions are handled at the MACHINE level, so they
  // apply in any state. A save whose completion arrives during `loading` (a
  // REFRESH fired mid-save) is still handled here — no stranding, and no need to
  // duplicate these three handlers into `loading`. (The freshness axis owning
  // `loading`/`ready` in the chart is unrelated to a record's save finishing.)
  on: {
    SAVE_OK: {
      do: (ctx, ev) => {
        const row = ctx.rows.find((r) => r.id === ev.id)
        if (row) {
          row.onHand = ev.quantity
          row.draft = ev.quantity
          row.version = ev.version
        }
        ctx.saves[ev.id] = { phase: 'clean', message: '' }
      },
    },
    SAVE_CONFLICT: {
      do: (ctx, ev) => {
        ctx.saves[ev.id] = {
          phase: 'conflict',
          message: `Now ${ev.quantity} elsewhere — refresh, then re-edit`,
        }
      },
    },
    SAVE_FAILED: {
      do: (ctx, ev) => {
        ctx.saves[ev.id] = { phase: 'failed', message: ev.message }
      },
    },
  },

  selectors: {
    rows: (ctx) => ctx.rows,
    loadedAt: (ctx) => ctx.loadedAt,
    loadError: (ctx) => ctx.loadError,
    // Curried per-record lookup — the template asks `saveOf(id)` per row.
    saveOf: (ctx) => (id: string): SaveState => ctx.saves[id] ?? { phase: 'clean', message: '' },
    dirtyCount: (ctx) => ctx.rows.filter((r) => r.draft !== r.onHand).length,
  },
})
