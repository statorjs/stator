// Type-level: a template machine instance types both `.state` (its state-name
// union) and `.send()` (its event union), so a state or event typo — in a name
// or a payload — is a compile error instead of being swallowed by `string` /
// `{ type: string }`. Checked by `tsc --noEmit`.
import { defineMachine } from '../src/server/define-machine.ts'
import type { InstanceOf } from '../src/template/types.ts'

const M = defineMachine({
  name: 'StateTypingMachine',
  lifecycle: 'session',
  events: {} as { type: 'GO' } | { type: 'SET'; n: number },
  context: { n: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        GO: { to: 'active' },
        SET: {
          do: (ctx, ev) => {
            ctx.n = ev.n
          },
        },
      },
    },
    active: {},
  },
  selectors: { n: (ctx) => ctx.n },
})

declare const s: InstanceOf<typeof M>

// --- state names ---
const okIdle: boolean = s.state === 'idle'
const okActive: boolean = s.state === 'active'
// @ts-expect-error 'reddy' is not a state of StateTypingMachine
const badState: boolean = s.state === 'reddy'

// --- send: event names + payloads ---
s.send({ type: 'GO' })
s.send({ type: 'SET', n: 5 })
// @ts-expect-error 'GOO' is not an event of StateTypingMachine
s.send({ type: 'GOO' })
// @ts-expect-error SET requires a numeric `n` payload
s.send({ type: 'SET' })

void okIdle
void okActive
void badState
