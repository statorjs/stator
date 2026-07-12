import { bind, effect, machine, use } from '../src/client/index.ts'

/**
 * Type-level contract for the typed client surface (checked by `tsc` over
 * the test tree — vitest never runs this; the assertions are compile-time).
 */

const Sel = machine(
  { color: '', count: 0 },
  {
    on: {
      PICK: (s, ev) => {
        s.color = String(ev.color)
        s.count += 1
      },
      RESET: {
        when: (s) => s.count > 0,
        do: (s) => {
          s.count = 0
        },
      },
    },
    select: { label: (s) => s.color.toUpperCase(), big: (s) => s.count > 9 },
  },
)
const sel = use(Sel, () => ({ color: 'gull' }))

// context + selector properties are typed (never-proofed assertions):
const _color: typeof sel.color extends string
  ? typeof sel.color extends never
    ? never
    : true
  : false = true
const _label: typeof sel.label extends string
  ? typeof sel.label extends never
    ? never
    : true
  : false = true
const _big: typeof sel.big extends boolean ? (typeof sel.big extends never ? never : true) : false =
  true
// @ts-expect-error unknown property
sel.nope
// typed instances flow into bind/effect (the base surface):
effect([sel], () => {})
bind(
  [sel],
  () => sel.count,
  () => {},
)
// send: loose events + string shorthand
sel.send({ type: 'PICK', color: 'kelp' })
sel.send('RESET')

// legacy one-bag keeps compiling, loosely:
const Legacy = machine({
  mode: 'light',
  on: {
    T: (s) => {
      s.mode = 'dark'
    },
  },
})
const legacy = use(Legacy)
legacy.send('T')
const _legacyLoose: typeof legacy.mode = 'anything types as any'
void _color
void _label
void _big
void _legacyLoose
