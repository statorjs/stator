import { defineMachine } from '@statorjs/stator/server'

/**
 * The gateway machine — the documented pattern from the app-machines guide,
 * now proven: browsers may only drive their own session machines, so shared
 * state (inventory) is commanded THROUGH this session machine, whose guard
 * is the authorization boundary. The demo's "become admin" is a dev-mode
 * toggle, honestly labeled; a real app gates BECOME_ADMIN with auth.
 */
export default defineMachine({
  name: 'AdminMachine',
  lifecycle: 'session',
  events: {} as
    | { type: 'BECOME_ADMIN' }
    | { type: 'LEAVE_ADMIN' }
    | { type: 'REQUEST_RESTOCK'; sku: string },
  emits: {
    restockRequested: {
      payload: (_ctx, ev: { sku: string }) => ({ sku: ev.sku }),
    },
  },
  context: { isAdmin: false },
  initial: 'ready',
  states: {
    ready: {
      on: {
        BECOME_ADMIN: {
          do: (ctx) => {
            ctx.isAdmin = true
          },
        },
        LEAVE_ADMIN: {
          do: (ctx) => {
            ctx.isAdmin = false
          },
        },
        REQUEST_RESTOCK: {
          // The gate. A forged POST without the toggle is silently dropped
          // (committed: false on the wire).
          when: (ctx) => ctx.isAdmin,
          emit: 'restockRequested',
        },
      },
    },
  },
  selectors: {
    isAdmin: (ctx) => ctx.isAdmin,
  },
})
