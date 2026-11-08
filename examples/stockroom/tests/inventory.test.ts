import { createActor } from '@statorjs/stator/machine'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
    assert.equal(actor.getSnapshot().context.saves.r1!.phase, 'saving')

    // Completion arrives while still in `ready` → handled.
    actor.send({ type: 'SAVE_OK', id: 'r1', quantity: 12, version: 2 })
    assert.equal(actor.getSnapshot().context.saves.r1!.phase, 'clean')
    assert.equal(actor.getSnapshot().context.rows.find((r) => r.id === 'r1')!.onHand, 12)
  })
})

describe('inventory — a completion is NOT stranded when the machine moved on (machine-level on:)', () => {
  it('a REFRESH mid-save no longer drops the completion — machine-level on: handles it', () => {
    const actor = loaded()
    actor.send({ type: 'SAVE', id: 'r1' }) // saves.r1 = saving; effect in flight
    assert.equal(actor.getSnapshot().context.saves.r1!.phase, 'saving')

    // A REFRESH — triggered for the COLLECTION, unrelated to r1 — moves the
    // machine-wide axis to `loading`.
    actor.send({ type: 'REFRESH' })

    // r1's save completes while the machine is in `loading`. Because SAVE_OK is
    // handled at the machine level (any state), it is NOT dropped — the row
    // settles to clean instead of stranding in `saving`. This is the whole point
    // of the machine-level `on:` primitive.
    actor.send({ type: 'SAVE_OK', id: 'r1', quantity: 12, version: 2 })

    assert.equal(actor.getSnapshot().context.saves.r1!.phase, 'clean')
  })
})

describe('inventory — delete a row', () => {
  it('REMOVE drops the row from the collection (drives a keyed each remove)', () => {
    const actor = loaded()
    assert.deepStrictEqual(actor.getSnapshot().context.rows.map((r) => r.id), ['r1', 'r2'])

    actor.send({ type: 'REMOVE', id: 'r1' })

    const { rows, saves } = actor.getSnapshot().context
    assert.deepStrictEqual(rows.map((r) => r.id), ['r2'])
    assert.equal(saves.r1, undefined)
  })
})
