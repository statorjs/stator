import { defineMachine } from '@statorjs/stator/server'

export default defineMachine({
  name: 'NoopMachine',
  lifecycle: 'session',
  events: {} as { type: 'X' },
  context: {},
  initial: 's',
  states: { s: {} },
})
