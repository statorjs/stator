// @vitest-environment happy-dom
// SPIKE (finding #5 / option C): item-value bindings inside a non-keyed each.
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

type Row = { id: string; label: string; tags?: string[] }

function makeList() {
  type Events = { type: 'SET'; rows: Row[] }
  return defineMachine({
    name: 'ListMachine',
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
  runtime.processEvent('ListMachine', { type: 'SET', rows: initial })
  const list = runtime.proxyFor('ListMachine') as InstanceOf<ReturnType<typeof makeList>>
  const state = createRenderState('s1', 'GET /')
  return { runtime, list, state }
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, label: `label-${id}` }))

function renderList(
  state: ReturnType<typeof createRenderState>,
  list: InstanceOf<ReturnType<typeof makeList>>,
) {
  // Mirrors what the compiler would lower `{r.label}` inside each to.
  return runInRender(
    state,
    () =>
      html`<ul>${each(
        read(list, (l) => l.rows),
        () => html`<li>${itemBind((r: Row) => r.label)}</li>`,
      )}</ul>`,
  )
}

function update(
  runtime: SessionRuntime,
  state: ReturnType<typeof createRenderState>,
  next: Row[],
): Patch[] {
  runtime.processEvent('ListMachine', { type: 'SET', rows: next })
  return recompute(state, 'ListMachine', runtime)
}

describe('each: item-value bindings (SPIKE option C)', () => {
  it('renders an addressable slot per item interpolation', async () => {
    const { list, state } = await buildRuntime(rows('a', 'b'))
    const out = renderList(state, list)
    expect(out.html).toMatch(/<span data-slot="[^"]+">label-a<\/span>/)
    expect(out.html).toMatch(/<span data-slot="[^"]+">label-b<\/span>/)
  })

  it('a content change patches ONLY the changed field — no wholesale re-render', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b'))
    renderList(state, list)

    const patches = update(runtime, state, [
      { id: 'a', label: 'CHANGED-a' },
      { id: 'b', label: 'label-b' },
    ])

    expect(patches).toHaveLength(1)
    expect(patches[0]!.op).toBe('text')
    expect((patches[0] as { value: string }).value).toBe('CHANGED-a')
    expect(patches.some((p) => p.op === 'html')).toBe(false)
  })

  it('emits nothing when content is unchanged despite item-identity churn', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b'))
    renderList(state, list)
    // Fresh objects, identical values — the old reference guard would re-render.
    const patches = update(runtime, state, rows('a', 'b'))
    expect(patches).toHaveLength(0)
  })

  it('falls back to a wholesale re-render when the length changes', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b'))
    renderList(state, list)
    const patches = update(runtime, state, rows('a', 'b', 'c'))
    expect(patches).toHaveLength(1)
    expect(patches[0]!.op).toBe('html')
  })

  it('compares a non-scalar item field deeply — churn is quiet, a real change patches', async () => {
    const withTags = (tags: string[]): Row[] => [{ id: 'a', label: 'A', tags }]
    const { runtime, list, state } = await buildRuntime(withTags(['x', 'y']))
    runInRender(
      state,
      () =>
        html`<ul>${each(
          read(list, (l) => l.rows),
          () => html`<li>${itemBind((r: Row) => r.tags)}</li>`,
        )}</ul>`,
    )
    // Same content, fresh array (machine clones the context) → no patch.
    expect(update(runtime, state, withTags(['x', 'y']))).toHaveLength(0)
    // Real content change → one text patch.
    const changed = update(runtime, state, withTags(['x', 'z']))
    expect(changed).toHaveLength(1)
    expect(changed[0]!.op).toBe('text')
  })
})
