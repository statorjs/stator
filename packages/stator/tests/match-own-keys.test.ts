import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { recompute } from '../src/server/recompute.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { match } from '../src/template/conditional.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'

/**
 * `match()` looks its arm up among the cases object's OWN properties. A
 * matched value that names an Object.prototype member (it can come from
 * data) finds no arm and renders an empty slot, as any value without an arm
 * does; before, it found the prototype member and the render threw.
 */

const PROTO_NAMES = ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'] as const

const Picker = defineMachine({
  name: 'PickerMachine',
  lifecycle: 'session',
  events: {} as { type: 'PICK'; key: string },
  context: { key: 'a' },
  initial: 'idle',
  states: {
    idle: {
      on: {
        PICK: {
          do: (ctx, ev) => {
            ctx.key = ev.key
          },
        },
      },
    },
  },
  selectors: {
    key: (ctx) => ctx.key,
  },
})

let sessions = 0

async function harness(initial = 'a') {
  const sid = `match-own-keys-${sessions++}`
  const store = new MachineStore([Picker], new InMemoryStore())
  const runtime = new SessionRuntime(sid, store)
  await runtime.loadGraph([Picker])
  if (initial !== 'a') runtime.processEvent('PickerMachine', { type: 'PICK', key: initial })
  const proxy = runtime.proxyFor('PickerMachine') as never
  const state = createRenderState(sid, 'GET /pick')
  return { runtime, proxy, state }
}

const keyOf = (p: unknown): string => (p as { key: string }).key

/** The slot's inner HTML, between its `<!--s:ID-->` markers. */
function slotInner(out: string): string {
  const m = /^<!--s:([^>]+)-->([\s\S]*)<!--\/s:\1-->$/.exec(out)
  assert.ok(m, `not a single slot: ${out}`)
  return m[2]!
}

function renderPlain(key: string, cases: Record<string, () => ReturnType<typeof html>>): string {
  const state = createRenderState('match-own-keys', 'GET /plain')
  return runInRender(state, () => match(key, cases).html)
}

describe('match() looks arms up among own properties only', () => {
  const cases = { a: () => html`<b>A</b>` }

  it('plain value: a prototype-named value renders what a value with no arm renders', () => {
    const none = renderPlain('missing', cases)
    assert.equal(slotInner(none), '')
    for (const name of PROTO_NAMES) {
      assert.equal(renderPlain(name, cases), none, `match("${name}")`)
    }
    assert.equal(slotInner(renderPlain('a', cases)), '<b>A</b>')
  })

  it('plain value: an arm the cases object really declares as `toString` still renders', () => {
    const own = { toString: () => html`<i>own</i>`, a: () => html`<b>A</b>` }
    assert.equal(slotInner(renderPlain('toString', own)), '<i>own</i>')
    assert.equal(slotInner(renderPlain('constructor', own)), '')
  })

  it('plain value: a null-prototype cases object still matches', () => {
    const bare = Object.assign(Object.create(null), { a: () => html`<b>A</b>` })
    assert.equal(slotInner(renderPlain('a', bare)), '<b>A</b>')
    assert.equal(slotInner(renderPlain('toString', bare)), '')
  })

  for (const name of PROTO_NAMES) {
    it(`machine-bound: "${name}" renders an empty slot on first render`, async () => {
      const { proxy, state } = await harness(name)
      const out = runInRender(state, () => match(read(proxy, keyOf), cases).html)
      assert.equal(slotInner(out), '')
    })

    it(`machine-bound: switching to "${name}" patches the slot empty, and back renders the arm`, async () => {
      const { runtime, proxy, state } = await harness()
      const out = runInRender(state, () => match(read(proxy, keyOf), cases).html)
      assert.equal(slotInner(out), '<b>A</b>')

      runtime.processEvent('PickerMachine', { type: 'PICK', key: name })
      const away = recompute(state, 'PickerMachine', runtime)
      assert.equal(away.length, 1)
      assert.equal(away[0]!.op, 'html')
      assert.equal((away[0] as { value: string }).value, '')

      runtime.processEvent('PickerMachine', { type: 'PICK', key: 'a' })
      const back = recompute(state, 'PickerMachine', runtime)
      assert.equal(back.length, 1)
      assert.equal((back[0] as { value: string }).value, '<b>A</b>')
    })
  }

  it('machine-bound: a declared `toString` arm renders on first render and on a switch', async () => {
    const own = { toString: () => html`<i>own</i>`, a: () => html`<b>A</b>` }
    const first = await harness('toString')
    const out = runInRender(first.state, () => match(read(first.proxy, keyOf), own).html)
    assert.equal(slotInner(out), '<i>own</i>')

    const { runtime, proxy, state } = await harness()
    runInRender(state, () => match(read(proxy, keyOf), own).html)
    runtime.processEvent('PickerMachine', { type: 'PICK', key: 'toString' })
    const patches = recompute(state, 'PickerMachine', runtime)
    assert.equal(patches.length, 1)
    assert.equal((patches[0] as { value: string }).value, '<i>own</i>')
  })
})
