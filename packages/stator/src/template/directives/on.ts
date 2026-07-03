import { type EventDescriptor, isEventDescriptor } from '../../server/render-context.ts'
import { type DirectiveInvocation, defineDirective, invoke } from './core.ts'

type Handler = () => EventDescriptor | undefined

const onDirective = defineDirective<Handler>({
  name: 'on',
  apply({ modifier, arg, addAttribute }) {
    const result = arg()
    if (!isEventDescriptor(result)) {
      throw new Error(
        `stator: on('${modifier}', ...) handler must be exactly one machine.send(...) call. ` +
          `Multi-statement handlers and arbitrary side effects are not supported in the POC.`,
      )
    }
    addAttribute(`data-event-${modifier}`, JSON.stringify(result))
  },
})

export function on(modifier: string, handler: Handler): DirectiveInvocation<Handler> {
  return invoke(onDirective, modifier, handler)
}
