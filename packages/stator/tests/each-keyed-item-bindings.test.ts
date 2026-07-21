// @vitest-environment happy-dom
// SPIKE (finding #5 / option C, keyed): item-value bindings inside a KEYED each.
// Retained rows now emit field-level text patches instead of going stale.
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

type Row = { id: string; label: string }

function makeList() {
  type Events = { type: 'SET'; rows: Row[] }
  return defineMachine({
    name: 'KeyedListMachine',
    lifecycle: 'session',
    events: {} as Events,
    context: { rows: [] as Row[] },
    initial: 'idle',
    states: {
      idle: {
        on: {
          SET: (ctx, ev) => {
            ctx.rows = ev.rows
          },
        },
      },
    },
    selectors: { rows: (ctx) => ctx.rows },
  })
}

async function buildRuntime(initial: Row[]) {
  const List = makeList()
  const store = new MachineStore([List], new InMemoryStore())
  await store.bootAppMachines()
  const runtime = new SessionRuntime('s1', store)
  await runtime.loadGraph([List])
  runtime.processEvent('KeyedListMachine', { type: 'SET', rows: initial })
  const list = runtime.proxyFor('KeyedListMachine') as InstanceOf<ReturnType<typeof makeList>>
  const state = createRenderState('s1', 'GET /')
  return { runtime, list, state }
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, label: `label-${id}` }))

function renderList(
  state: ReturnType<typeof createRenderState>,
  list: InstanceOf<ReturnType<typeof makeList>>,
) {
  // Mirrors what the compiler lowers a keyed `{r.label}` to.
  return runInRender(
    state,
    () =>
      html`<ul>${each(
        read(list, (l) => l.rows),
        () => html`<li>${itemBind((r: Row) => r.label)}</li>`,
        { key: (r: Row) => r.id },
      )}</ul>`,
  )
}

function update(
  runtime: SessionRuntime,
  state: ReturnType<typeof createRenderState>,
  next: Row[],
): Patch[] {
  runtime.processEvent('KeyedListMachine', { type: 'SET', rows: next })
  return recompute(state, 'KeyedListMachine', runtime)
}

describe('keyed each: item-value bindings (SPIKE option C)', () => {
  it('patches a retained row in place — one text patch, no move/insert/remove/html', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b'))
    renderList(state, list)
    const patches = update(runtime, state, [
      { id: 'a', label: 'CHANGED-a' },
      { id: 'b', label: 'label-b' },
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0]!.op).toBe('text')
    expect((patches[0] as { value: string }).value).toBe('CHANGED-a')
    expect(patches.some((p) => ['move', 'insert', 'remove', 'html'].includes(p.op))).toBe(false)
  })

  it('emits nothing on identity churn with unchanged content', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b'))
    renderList(state, list)
    expect(update(runtime, state, rows('a', 'b'))).toHaveLength(0)
  })

  it('combines a move with an in-place content patch when a row both reorders and changes', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b'))
    renderList(state, list)
    const patches = update(runtime, state, [
      { id: 'b', label: 'CHANGED-b' },
      { id: 'a', label: 'label-a' },
    ])
    expect(patches.some((p) => p.op === 'move')).toBe(true)
    const text = patches.find((p) => p.op === 'text') as { value: string } | undefined
    expect(text?.value).toBe('CHANGED-b')
    // No wholesale re-render of the retained row.
    expect(patches.some((p) => p.op === 'html')).toBe(false)
  })

  it('inserts a new key without emitting item-binding patches for it', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a'))
    renderList(state, list)
    const patches = update(runtime, state, rows('a', 'b'))
    expect(patches.some((p) => p.op === 'insert')).toBe(true)
    // 'a' is unchanged and 'b' is fresh in the insert HTML → no stray text patch.
    expect(patches.some((p) => p.op === 'text')).toBe(false)
  })
})
