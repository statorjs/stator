import { defineMachine } from '@statorjs/stator/server'

/**
 * The whole app's business logic, UI-blind and unit-testable. Session-scoped:
 * every visitor gets their own list, and it survives page reloads because
 * the SERVER owns it — no localStorage, no sync.
 */

export interface Todo {
  id: string
  title: string
  done: boolean
}

type Events =
  | { type: 'ADD'; title: string }
  | { type: 'TOGGLE'; id: string }
  | { type: 'TOGGLE_ALL' }
  | { type: 'DESTROY'; id: string }
  | { type: 'EDIT_START'; id: string }
  | { type: 'EDIT_SAVE'; id: string; title: string }
  | { type: 'EDIT_CANCEL' }
  | { type: 'CLEAR_COMPLETED' }

let nextId = 0

export default defineMachine({
  name: 'TodosMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: {
    todos: [] as Todo[],
    /** The row currently in edit mode, or ''. Server state — that's what
     *  lets in-place editing work with zero client JavaScript. */
    editingId: '',
  },
  initial: 'ready',
  states: {
    ready: {
      on: {
        ADD: {
          when: (_ctx, ev) => ev.title.trim().length > 0,
          do: (ctx, ev) => {
            ctx.todos.push({ id: `t${nextId++}`, title: ev.title.trim(), done: false })
          },
        },
        TOGGLE: {
          do: (ctx, ev) => {
            const todo = ctx.todos.find((t) => t.id === ev.id)
            if (todo) todo.done = !todo.done
          },
        },
        TOGGLE_ALL: {
          do: (ctx) => {
            const allDone = ctx.todos.every((t) => t.done)
            for (const t of ctx.todos) t.done = !allDone
          },
        },
        DESTROY: {
          do: (ctx, ev) => {
            const i = ctx.todos.findIndex((t) => t.id === ev.id)
            if (i !== -1) ctx.todos.splice(i, 1)
            if (ctx.editingId === ev.id) ctx.editingId = ''
          },
        },
        EDIT_START: {
          when: (ctx, ev) => ctx.todos.some((t) => t.id === ev.id),
          do: (ctx, ev) => {
            ctx.editingId = ev.id
          },
        },
        EDIT_SAVE: {
          do: (ctx, ev) => {
            const title = ev.title.trim()
            const i = ctx.todos.findIndex((t) => t.id === ev.id)
            if (i !== -1) {
              // Saving an emptied title deletes the todo (TodoMVC convention).
              if (title === '') ctx.todos.splice(i, 1)
              else ctx.todos[i]!.title = title
            }
            ctx.editingId = ''
          },
        },
        EDIT_CANCEL: {
          do: (ctx) => {
            ctx.editingId = ''
          },
        },
        CLEAR_COMPLETED: {
          do: (ctx) => {
            ctx.todos = ctx.todos.filter((t) => !t.done)
          },
        },
      },
    },
  },
  selectors: {
    all: (ctx) => ctx.todos,
    activeCount: (ctx) => ctx.todos.filter((t) => !t.done).length,
    completedCount: (ctx) => ctx.todos.filter((t) => t.done).length,
    total: (ctx) => ctx.todos.length,
    allDone: (ctx) => ctx.todos.length > 0 && ctx.todos.every((t) => t.done),
    editingId: (ctx) => ctx.editingId,
  },
})
