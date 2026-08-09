import { bind, effect, machine, use } from '../src/client/index.ts'

/**
 * Type-level contract for the typed client surface (checked by `tsc` over
 * the test tree — vitest never runs this; the assertions are compile-time).
 *
 * Three event-typing tiers (the Minor A foundation of the reactive-model
 * regrounding spec):
 *   1. data-only / no `on`      → loose ClientEvent (compat: @set carriers)
 *   2. `on` map, no `events:`   → DERIVED names union (typo-safe send)
 *   3. `events: {} as E`        → DECLARED union (full payload typing)
 */

// ---------------------------------------------------------------------------
// Tier 2: derived names union — the existing terse form, now typo-safe.
// ---------------------------------------------------------------------------
const Sel = machine(
  { color: '', count: 0 },
  {
    on: {
      PICK: (s, ev) => {
        s.color = String(ev.color) // ev is ClientEvent; payloads stay open
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
// derived names: declared events send fine, payloads open
sel.send({ type: 'PICK', color: 'kelp' })
sel.send('RESET')
sel.send('PICK') // payloads are open in the derived tier — bare string allowed
// @ts-expect-error event-name typo is now a compile error
sel.send('RESTE')
// @ts-expect-error undeclared event name in object form
sel.send({ type: 'NOPE' })

// handlers are contextually typed from the context (the two-arg guarantee):
machine(
  { count: 0 },
  {
    on: {
      OOPS: (s) => {
        // @ts-expect-error `missing` is not a context key
        s.missing = 1
      },
    },
  },
)

// ---------------------------------------------------------------------------
// Tier 3: declared union — mirrors defineMachine's `events:` field.
// ---------------------------------------------------------------------------
type DraftEvents = { type: 'TYPE'; text: string } | { type: 'CLEAR' }
const Draft = machine(
  { text: '' },
  {
    events: {} as DraftEvents,
    on: {
      TYPE: (s, e) => {
        s.text = e.text // e narrowed to { type: 'TYPE'; text: string } — no annotation
      },
      CLEAR: (s) => {
        s.text = ''
      },
    },
  },
)
const draft = use(Draft)

draft.send({ type: 'TYPE', text: 'hello' })
draft.send('CLEAR') // payload-less events keep the string shorthand
// @ts-expect-error payload-carrying events cannot be sent as a bare string
draft.send('TYPE')
// @ts-expect-error wrong payload type
draft.send({ type: 'TYPE', text: 42 })
// @ts-expect-error missing required payload
draft.send({ type: 'TYPE' })
// @ts-expect-error name typo
draft.send('CLERA')

// a handler for an undeclared event is an error:
machine(
  { text: '' },
  {
    events: {} as DraftEvents,
    on: {
      // @ts-expect-error UNDECLARED is not in the declared union
      UNDECLARED: (s) => {
        s.text = ''
      },
    },
  },
)

// declared tier still contextually types ctx:
machine(
  { text: '' },
  {
    events: {} as DraftEvents,
    on: {
      CLEAR: (s) => {
        // @ts-expect-error `missing` is not a context key
        s.missing = 1
      },
    },
  },
)

// ---------------------------------------------------------------------------
// Tier 1: data-only stays LOOSE — the @set / bind:value carrier until 2.0.
// ---------------------------------------------------------------------------
const Bag = machine({ text: '' })
const bag = use(Bag)
bag.send({ type: '@set', key: 'text', value: '' }) // hand-written eject pattern
bag.send('ANYTHING') // loose by design until @set is removed

// behavior with selectors but no `on` is also loose:
const SelOnly = machine({ n: 0 }, { select: { double: (s) => s.n * 2 } })
const selOnly = use(SelOnly)
const _double: typeof selOnly.double extends number ? true : false = true
selOnly.send('ANYTHING')

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
void _double
void _legacyLoose
