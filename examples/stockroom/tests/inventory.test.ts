import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import InventoryMachine from '../machines/inventory.ts'
import type { StockRecord } from '../lib/inventory-source.ts'

// Effects are host-scheduled, so a bare actor does not run the async save/load
// itself — which lets these tests DELIVER the completion events by hand and
// control exactly where the machine is when a completion arrives. That is the
// whole variable in the stranded-completion finding.

const rows: StockRecord[] = [
  { id: 'r1', sku: 'A', name: 'Item A', quantity: 10, version: 1 },
  { id: 'r2', sku: 'B', name: 'Item B', quantity: 20, version: 1 },
]

const loaded = () => {
  const actor = createActor(InventoryMachine).start()
  actor.send({ type: 'LOADED', rows }) // loading → ready, seeds ctx.saves
  return actor
}

describe('inventory — the happy path works', () => {
  it('a save whose completion arrives in `ready` settles the row to clean', () => {
    const actor = loaded()
    actor.send({ type: 'SAVE', id: 'r1' })
    expect(actor.getSnapshot().context.saves.r1!.phase).toBe('saving')

    // Completion arrives while still in `ready` → handled.
    actor.send({ type: 'SAVE_OK', id: 'r1', quantity: 12, version: 2 })
    expect(actor.getSnapshot().context.saves.r1!.phase).toBe('clean')
    expect(actor.getSnapshot().context.rows.find((r) => r.id === 'r1')!.onHand).toBe(12)
  })
})

describe('inventory — a completion is NOT stranded when the machine moved on (machine-level on:)', () => {
  it('a REFRESH mid-save no longer drops the completion — machine-level on: handles it', () => {
    const actor = loaded()
    actor.send({ type: 'SAVE', id: 'r1' }) // saves.r1 = saving; effect in flight
    expect(actor.getSnapshot().context.saves.r1!.phase).toBe('saving')

    // A REFRESH — triggered for the COLLECTION, unrelated to r1 — moves the
    // machine-wide axis to `loading`.
    actor.send({ type: 'REFRESH' })

    // r1's save completes while the machine is in `loading`. Because SAVE_OK is
    // handled at the machine level (any state), it is NOT dropped — the row
    // settles to clean instead of stranding in `saving`. This is the whole point
    // of the machine-level `on:` primitive.
    actor.send({ type: 'SAVE_OK', id: 'r1', quantity: 12, version: 2 })

    expect(actor.getSnapshot().context.saves.r1!.phase).toBe('clean')
  })
})

describe('inventory — delete a row', () => {
  it('REMOVE drops the row from the collection (drives a keyed each remove)', () => {
    const actor = loaded()
    expect(actor.getSnapshot().context.rows.map((r) => r.id)).toEqual(['r1', 'r2'])

    actor.send({ type: 'REMOVE', id: 'r1' })

    const { rows, saves } = actor.getSnapshot().context
    expect(rows.map((r) => r.id)).toEqual(['r2'])
    expect(saves.r1).toBeUndefined()
  })
})
