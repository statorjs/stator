import { defineMachine } from '../../../../src/server/define-machine.ts'

type Events = { type: 'LOGIN' } | { type: 'LOGOUT' }

export default defineMachine({
  name: 'AuthMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { signedIn: false, name: '' },
  initial: 'ready',
  states: {
    ready: {
      on: {
        LOGIN: (ctx) => {
          ctx.signedIn = true
          ctx.name = 'Ada'
        },
        LOGOUT: (ctx) => {
          ctx.signedIn = false
          ctx.name = ''
        },
      },
    },
  },
  selectors: { signedIn: (ctx) => ctx.signedIn, name: (ctx) => ctx.name },
})
