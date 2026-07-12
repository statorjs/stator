import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import TodosMachine from '../machines/todos.ts'

/**
 * Every rule of the app, tested without a browser — events in, state out.
 * This file is the testing guide's pyramid in miniature:
 * https://docs.statorjs.dev/guides/testing/
 */

describe('todos', () => {
  it('adds trimmed todos and guards out empty ones', () => {
    const actor = createActor(TodosMachine).start()
    actor.send({ type: 'ADD', title: '  feed the cat  ' })
    actor.send({ type: 'ADD', title: '   ' }) // guard-dropped
    const { todos } = actor.getSnapshot().context
    expect(todos).toHaveLength(1)
    expect(todos[0]!.title).toBe('feed the cat')
  })

  it('toggle-all flips everything; flips back when all done', () => {
    const actor = createActor(TodosMachine).start()
    actor.send({ type: 'ADD', title: 'a' })
    actor.send({ type: 'ADD', title: 'b' })
    actor.send({ type: 'TOGGLE_ALL' })
    expect(actor.getSnapshot().context.todos.every((t) => t.done)).toBe(true)
    actor.send({ type: 'TOGGLE_ALL' })
    expect(actor.getSnapshot().context.todos.every((t) => !t.done)).toBe(true)
  })

  it('saving an emptied title deletes the todo (TodoMVC convention)', () => {
    const actor = createActor(TodosMachine).start()
    actor.send({ type: 'ADD', title: 'typo' })
    const id = actor.getSnapshot().context.todos[0]!.id
    actor.send({ type: 'EDIT_START', id })
    actor.send({ type: 'EDIT_SAVE', id, title: '  ' })
    expect(actor.getSnapshot().context.todos).toHaveLength(0)
    expect(actor.getSnapshot().context.editingId).toBe('')
  })

  it('clear-completed keeps only active todos', () => {
    const actor = createActor(TodosMachine).start()
    actor.send({ type: 'ADD', title: 'keep' })
    actor.send({ type: 'ADD', title: 'drop' })
    const dropId = actor.getSnapshot().context.todos[1]!.id
    actor.send({ type: 'TOGGLE', id: dropId })
    actor.send({ type: 'CLEAR_COMPLETED' })
    expect(actor.getSnapshot().context.todos.map((t) => t.title)).toEqual(['keep'])
  })
})
