import { createActor } from '@statorjs/stator/machine'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import TodosMachine from '../machines/todos.ts'

/**
 * Every rule of the app, tested without a browser — events in, state out.
 * With wire.test.ts above it, this is the testing guide's pyramid in miniature:
 * https://docs.statorjs.dev/guides/testing/
 */

describe('todos', () => {
  it('adds trimmed todos and guards out empty ones', () => {
    const actor = createActor(TodosMachine).start()
    actor.send({ type: 'ADD', title: '  feed the cat  ' })
    actor.send({ type: 'ADD', title: '   ' }) // guard-dropped
    const { todos } = actor.getSnapshot().context
    assert.equal(todos.length, 1)
    assert.equal(todos[0]!.title, 'feed the cat')
  })

  it('toggle-all flips everything; flips back when all done', () => {
    const actor = createActor(TodosMachine).start()
    actor.send({ type: 'ADD', title: 'a' })
    actor.send({ type: 'ADD', title: 'b' })
    actor.send({ type: 'TOGGLE_ALL' })
    assert.equal(actor.getSnapshot().context.todos.every((t) => t.done), true)
    actor.send({ type: 'TOGGLE_ALL' })
    assert.equal(actor.getSnapshot().context.todos.every((t) => !t.done), true)
  })

  it('saving an emptied title deletes the todo (TodoMVC convention)', () => {
    const actor = createActor(TodosMachine).start()
    actor.send({ type: 'ADD', title: 'typo' })
    const id = actor.getSnapshot().context.todos[0]!.id
    actor.send({ type: 'EDIT_START', id })
    actor.send({ type: 'EDIT_SAVE', id, title: '  ' })
    assert.equal((actor.getSnapshot().context.todos).length, 0)
    assert.equal(actor.getSnapshot().context.editingId, '')
  })

  it('clear-completed keeps only active todos', () => {
    const actor = createActor(TodosMachine).start()
    actor.send({ type: 'ADD', title: 'keep' })
    actor.send({ type: 'ADD', title: 'drop' })
    const dropId = actor.getSnapshot().context.todos[1]!.id
    actor.send({ type: 'TOGGLE', id: dropId })
    actor.send({ type: 'CLEAR_COMPLETED' })
    assert.deepStrictEqual(actor.getSnapshot().context.todos.map((t) => t.title), ['keep'])
  })
})
