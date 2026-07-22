// @vitest-environment happy-dom
// Attribute-position `read(item, …)` → itemBind: emits `attr` patches (not
// `text`), with boolean attribute semantics, and targets the row's key-scoped
// element id — stable across a move (the scope/identity seam).
import { describe, expect, it } from 'vitest'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { recompute } from '../src/server/recompute.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { each, itemBind } from '../src/template/each.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'
import type { InstanceOf } from '../src/template/types.ts'
import type { Patch } from '../src/wire/index.ts'

type Row = { id: string; color: string; done: boolean }

function makeList() {
  return defineMachine({
    name: 'AttrListMachine',
    lifecycle: 'session',
    events: {} as { type: 'SET'; rows: Row[] },
    context: { rows: [] as Row[] },
    initial: 'idle',
    states: {
      idle: {
        on: {
          SET: (c, e) => {
            c.rows = e.rows
          },
        },
      },
    },
    selectors: { rows: (c) => c.rows },
  })
}

async function build(initial: Row[]) {
  const M = makeList()
  const store = new MachineStore([M], new InMemoryStore())
  await store.bootAppMachines()
  const rt = new SessionRuntime('s1', store)
  await rt.loadGraph([M])
  rt.processEvent('AttrListMachine', { type: 'SET', rows: initial })
  const list = rt.proxyFor('AttrListMachine') as InstanceOf<ReturnType<typeof makeList>>
  return { rt, list, state: createRenderState('s1', 'GET /') }
}

const row = (id: string, color: string, done = false): Row => ({ id, color, done })

function update(
  rt: SessionRuntime,
  state: ReturnType<typeof createRenderState>,
  next: Row[],
): Patch[] {
  rt.processEvent('AttrListMachine', { type: 'SET', rows: next })
  return recompute(state, 'AttrListMachine', rt)
}

// A keyed row whose class + checked come from read(item, …).
const renderKeyed = (
  state: ReturnType<typeof createRenderState>,
  list: InstanceOf<ReturnType<typeof makeList>>,
) =>
  runInRender(
    state,
    () =>
      html`<ul>${each(
        read(list, (l) => l.rows),
        () =>
          html`<li class="${itemBind((r: Row) => r.color)}"><input type="checkbox" checked="${itemBind(
            (r: Row) => r.done,
          )}" /></li>`,
        { key: (r: Row) => r.id },
      )}</ul>`,
  )

describe('attr-position item bindings', () => {
  it('a class change emits an attr patch — not a text patch, not a re-render (non-keyed)', async () => {
    const { rt, list, state } = await build([row('a', 'red')])
    runInRender(
      state,
      () =>
        html`<ul>${each(
          read(list, (l) => l.rows),
          () => html`<li class="${itemBind((r: Row) => r.color)}">x</li>`,
        )}</ul>`,
    )
    const patches = update(rt, state, [row('a', 'blue')])
    expect(patches).toHaveLength(1)
    expect(patches[0]!.op).toBe('attr')
    expect((patches[0] as { name: string }).name).toBe('class')
    expect((patches[0] as { value: string }).value).toBe('blue')
  })

  it('boolean attr: checked true→false emits an attr patch that removes it', async () => {
    const { rt, list, state } = await build([row('a', 'red', true)])
    renderKeyed(state, list)
    const patches = update(rt, state, [row('a', 'red', false)])
    expect(patches).toHaveLength(1)
    expect(patches[0]!.op).toBe('attr')
    expect((patches[0] as { name: string }).name).toBe('checked')
    expect((patches[0] as { value: string | null }).value).toBeNull()
  })

  it('unchanged attrs emit nothing on churn', async () => {
    const { rt, list, state } = await build([row('a', 'red', true)])
    renderKeyed(state, list)
    expect(update(rt, state, [row('a', 'red', true)])).toHaveLength(0)
  })

  it('keyed: an attr patch targets the row’s own element, wherever it moved (the seam)', async () => {
    const { rt, list, state } = await build([row('a', 'red'), row('b', 'green')])
    const out = renderKeyed(state, list)
    // <li> element ids in render order: [a's, b's].
    const liIds = [...out.html.matchAll(/<li data-stator-id="([^"]+)"/g)].map((m) => m[1])
    expect(liIds).toHaveLength(2)
    const bLiId = liIds[1]

    // Reorder [a,b] → [b,a] AND change b's color.
    const patches = update(rt, state, [row('b', 'blue'), row('a', 'red')])
    expect(patches.some((p) => p.op === 'move')).toBe(true)
    const classPatch = patches.find(
      (p) => p.op === 'attr' && (p as { name: string }).name === 'class',
    ) as { value: string; target: { id: string } } | undefined
    expect(classPatch?.value).toBe('blue')
    // The patch addresses b's element by its key-scoped id — not a's.
    expect(classPatch?.target.id).toBe(bLiId)
  })
})
