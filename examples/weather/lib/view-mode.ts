import { defineMachine } from '@statorjs/stator/machine'

/**
 * The app bar's view: three mutually exclusive modes with rules for moving
 * between them. It is chrome state that belongs to one tab, so it runs in the
 * browser: the `app-bar-ctl` island passes this module to `use()`. Nothing in
 * it is browser-specific, which is why `tests/view-mode.test.ts` can run the
 * same definition in Node.
 */
export default defineMachine({
  name: 'ViewMode',
  lifecycle: 'session',
  events: {} as { type: 'TOGGLE_SETTINGS' } | { type: 'TOGGLE_EDIT' } | { type: 'DISMISS' },
  context: {},
  initial: 'idle',
  states: {
    idle: {
      on: { TOGGLE_SETTINGS: { to: 'settings' }, TOGGLE_EDIT: { to: 'editing' } },
    },
    // The transient drawer: an outside tap or Escape (`DISMISS`) closes it.
    settings: {
      on: {
        TOGGLE_SETTINGS: { to: 'idle' },
        TOGGLE_EDIT: { to: 'editing' },
        DISMISS: { to: 'idle' },
      },
    },
    // A deliberate mode, left only by its own button: `DISMISS` is not
    // handled here, so the rule is the chart's and no caller has to know it.
    editing: {
      on: { TOGGLE_EDIT: { to: 'idle' }, TOGGLE_SETTINGS: { to: 'settings' } },
    },
  },
  selectors: {},
})
