import { createActor } from '@statorjs/stator/machine'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import ViewMode from '../lib/view-mode.ts'

// The island runs this machine in the browser; the definition is the same
// here, so its rules are tested without one.
const start = () => createActor(ViewMode).start()
const mode = (a: ReturnType<typeof start>) => a.getSnapshot().value.at(-1)

describe('view mode', () => {
  it('toggles the settings drawer', () => {
    const v = start()
    v.send({ type: 'TOGGLE_SETTINGS' })
    assert.equal(mode(v), 'settings')
    v.send({ type: 'TOGGLE_SETTINGS' })
    assert.equal(mode(v), 'idle')
  })

  it('DISMISS closes the drawer and leaves edit mode alone', () => {
    const v = start()
    v.send({ type: 'TOGGLE_SETTINGS' })
    v.send({ type: 'DISMISS' })
    assert.equal(mode(v), 'idle')
    v.send({ type: 'TOGGLE_EDIT' })
    v.send({ type: 'DISMISS' })
    assert.equal(mode(v), 'editing')
  })

  it('moves straight between settings and editing', () => {
    const v = start()
    v.send({ type: 'TOGGLE_SETTINGS' })
    v.send({ type: 'TOGGLE_EDIT' })
    assert.equal(mode(v), 'editing')
    v.send({ type: 'TOGGLE_SETTINGS' })
    assert.equal(mode(v), 'settings')
  })
})
