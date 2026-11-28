// Type-level tests for refusal reasons (engine half): `refuse` exists on guard
// helpers only, returns `false`, and a guard written against `ActionHelpers`
// still assigns where a `Guard` is expected.
import {
  type ActionHelpers,
  type Actor,
  createActor,
  defineMachine,
  type Guard,
  type GuardHelpers,
  type Refusal,
  type SendResult,
} from '../src/engine/index.ts'

type Events = { type: 'GO'; n: number } | { type: 'STOP' }

// A guard annotated against the supertype still assigns.
const oldStyle = (_ctx: { n: number }, ev: { type: 'GO'; n: number }, _h: ActionHelpers): boolean =>
  ev.n > 0

const M = defineMachine({
  name: 'Typed',
  lifecycle: 'session',
  events: {} as Events,
  context: { n: 0 },
  initial: 'a',
  states: {
    a: {
      on: {
        GO: [
          { when: oldStyle, to: 'a' },
          { when: (_c, _e, { refuse }) => refuse('no'), to: 'a' },
        ],
        STOP: {
          // @ts-expect-error actions get ActionHelpers, which has no refuse
          do: (_c, _e, { refuse }) => refuse('x'),
        },
      },
    },
  },
})

const a: Actor<{ n: number }, Events> = createActor(M).start()
const r: SendResult = a.send({ type: 'GO', n: 1 })
const committed: boolean = r.committed
const refusal: Refusal | undefined = r.refusal
void committed
void refusal

// refuse returns the literal false.
const g: Guard<{ n: number }, { type: 'GO'; n: number }> = (_c, _e, h) => {
  const f: false = h.refuse('code', { message: 'm', issues: [{ path: ['a', 0], message: 'm' }] })
  return f
}
void g

// @ts-expect-error a code is required
const bad: Guard<object, { type: 'GO' }> = (_c, _e, h) => h.refuse()
void bad

const badIssue = (h: GuardHelpers) =>
  // @ts-expect-error issue paths are strings and numbers
  h.refuse('invalid', { issues: [{ path: [true], message: 'm' }] })
void badIssue

// A refusal carries no data field.
// @ts-expect-error unknown property
const noData: Refusal = { code: 'full', data: { left: 2 } }
void noData
