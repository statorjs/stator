import { defineApiRoute } from '@statorjs/stator/server'
import TodosMachine from '../../machines/todos.ts'

/** The edit form posts here — values travel as forms (the platform's way);
 *  the machine decides what saving means (empty title = delete). */
export const POST = defineApiRoute({
  reads: [TodosMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    await dispatch(TodosMachine, {
      type: 'EDIT_SAVE',
      id: String(form.get('id') ?? ''),
      title: String(form.get('title') ?? ''),
    })
    return { directives: [{ type: 'navigate', to: '/' }] }
  },
})
