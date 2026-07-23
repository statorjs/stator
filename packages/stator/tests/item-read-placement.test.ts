// @vitest-environment happy-dom
// Item-read placement: a `read(item, …)` binding is owned by its each() row —
// the row render supplies the item and the list's recompute re-diffs it. A
// when()/match()/defer() arm re-renders on its own schedule (renderBranchBody),
// WITHOUT row context, so an item read inside an arm is a compile-time error
// (and a runtime error for hand-written templates). Shipped bug: todomvc's
// label sat inside a when() arm and crashed recompute on EDIT_SAVE (#24).
import { describe, expect, it } from 'vitest'
import { lowerTemplate } from '../src/compiler/lower.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { recompute } from '../src/server/recompute.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { when } from '../src/template/conditional.ts'
import { classList } from '../src/template/directives/list-attr.ts'
import { each, itemBind } from '../src/template/each.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'
import type { InstanceOf } from '../src/template/types.ts'

describe('lower: item-read placement gate', () => {
  const row = (inner: string) =>
    `<ul>{each(read(m, s => s.rows), (r) => <li>${inner}</li>, { key: (r) => r.id })}</ul>`

  it('rejects an item read inside a when() arm', () => {
    expect(() =>
      lowerTemplate(row('{when(read(m, s => s.editing), () => <b>{read(r, (x) => x.label)}</b>)}')),
    ).toThrow(/inside a when\(\) arm.*owned by its each\(\) row/s)
  })

  it('rejects an item read inside a match() arm', () => {
    expect(() =>
      lowerTemplate(
        row('{match(read(m, s => s.mode), { on: () => <b>{read(r, (x) => x.label)}</b> })}'),
      ),
    ).toThrow(/inside a match\(\) arm/)
  })

  it('rejects an item read as a when() condition', () => {
    expect(() => lowerTemplate(row('{when(read(r, (x) => x.done), () => <b>done</b>)}'))).toThrow(
      /cannot drive a when\(\)/,
    )
  })

  it('rejects reading an outer item from inside a nested each() row', () => {
    expect(() =>
      lowerTemplate(row('{each(r.items, (it) => <span>{read(r, (x) => x.label)}</span>)}')),
    ).toThrow(/outer each\(\)/)
  })

  it('rejects an item read inside a class:list spec', () => {
    expect(() =>
      lowerTemplate(row('<span class:list={{ done: read(r, (x) => x.done) }}>x</span>')),
    ).toThrow(/class:list spec/)
  })

  it('allows an item read bound to an each() nested inside an arm (the arm re-establishes row context)', () => {
    // live-poll's shape: the each is INSIDE the arm, so every arm render
    // re-creates the rows — and their item bindings — from scratch.
    const out = lowerTemplate(
      '<div>{when(read(m, s => s.open), () => <ul>{each(read(m, s => s.rows), (r) => <li>{read(r, (x) => x.count)}</li>)}</ul>)}</div>',
    )
    expect(out).toContain('itemBind((x) => x.count)')
  })

  it('allows a machine read inside an arm within a row', () => {
    const out = lowerTemplate(
      row('{when(read(m, s => s.editing), () => <b>{read(m, (s) => s.draft)}</b>)}'),
    )
    expect(out).toContain('read(m, (s) => s.draft)')
    expect(out).not.toContain('itemBind')
  })

  it('does not run the gate in a client-island shell (item reads are not lowered there)', () => {
    const out = lowerTemplate(
      row('{when(read(m, s => s.editing), () => <b>{read(r, (x) => x.label)}</b>)}'),
      { client: { useFields: new Set<string>(), directives: [] } },
    )
    expect(out).not.toContain('itemBind')
  })
})

// The runtime side: the legal todomvc shape (item read at row top level, a
// machine-read arm beside it) survives an arm flip; the illegal shape hits the
// itemBind backstop instead of a confusing crash.
type Row = { id: string; label: string }

function makeMachine() {
  type Events = { type: 'SET'; rows: Row[] } | { type: 'EDIT'; id: string | null }
  return defineMachine({
    name: 'ArmListMachine',
    lifecycle: 'session',
    events: {} as Events,
    context: { rows: [] as Row[], editingId: null as string | null },
    initial: 'idle',
    states: {
      idle: {
        on: {
          SET: (ctx, ev) => {
            ctx.rows = ev.rows
          },
          EDIT: (ctx, ev) => {
            ctx.editingId = ev.id
          },
        },
      },
    },
    selectors: { rows: (ctx) => ctx.rows, editingId: (ctx) => ctx.editingId },
  })
}

async function buildRuntime(initial: Row[]) {
  const M = makeMachine()
  const store = new MachineStore([M], new InMemoryStore())
  await store.bootAppMachines()
  const runtime = new SessionRuntime('s1', store)
  await runtime.loadGraph([M])
  runtime.processEvent('ArmListMachine', { type: 'SET', rows: initial })
  const m = runtime.proxyFor('ArmListMachine') as InstanceOf<ReturnType<typeof makeMachine>>
  const state = createRenderState('s1', 'GET /')
  return { runtime, m, state }
}

describe('runtime: item reads beside (not inside) arms', () => {
  it('an arm flip in a row with a top-level item read re-renders the arm without crashing (#24 todomvc regression)', async () => {
    const { runtime, m, state } = await buildRuntime([
      { id: 'a', label: 'label-a' },
      { id: 'b', label: 'label-b' },
    ])
    runInRender(
      state,
      () =>
        html`<ul>${each(
          read(m, (s) => s.rows),
          (r: Row) =>
            html`<li>${itemBind((x: Row) => x.label)}${when(
              read(m, (s) => s.editingId === r.id),
              () =>
                html`<em>${read(m, (s) => s.rows.find((x) => x.id === r.id)?.label ?? '')}</em>`,
            )}</li>`,
          { key: (r: Row) => r.id },
        )}</ul>`,
    )

    // Flip row a's arm on: the branch re-renders (no row context) — must not
    // throw, and the arm body arrives as an html patch.
    runtime.processEvent('ArmListMachine', { type: 'EDIT', id: 'a' })
    const patches = recompute(state, 'ArmListMachine', runtime)
    expect(patches.some((p) => p.op === 'html' && p.value.includes('label-a'))).toBe(true)

    // And flip it back off — the #24 crash fired on this transition.
    runtime.processEvent('ArmListMachine', { type: 'EDIT', id: null })
    expect(() => recompute(state, 'ArmListMachine', runtime)).not.toThrow()
  })

  it('an item read INSIDE an arm hits the itemBind ownership backstop on the arm re-render', async () => {
    const { runtime, m, state } = await buildRuntime([{ id: 'a', label: 'label-a' }])
    runInRender(
      state,
      () =>
        html`<ul>${each(
          read(m, (s) => s.rows),
          (r: Row) =>
            html`<li>${when(
              read(m, (s) => s.editingId !== r.id),
              () => html`<b>${itemBind((x: Row) => x.label)}</b>`,
            )}</li>`,
          { key: (r: Row) => r.id },
        )}</ul>`,
    )
    runtime.processEvent('ArmListMachine', { type: 'EDIT', id: 'a' })
    recompute(state, 'ArmListMachine', runtime) // arm off — renders empty, no itemBind call
    runtime.processEvent('ArmListMachine', { type: 'EDIT', id: null })
    // Arm back on: renderBranchBody re-runs the arm body without row context.
    expect(() => recompute(state, 'ArmListMachine', runtime)).toThrow(/owned by its row/)
  })

  it('rejects an item read inside a class:list/style:list spec at render time', async () => {
    const { m, state } = await buildRuntime([{ id: 'a', label: 'label-a' }])
    expect(() =>
      runInRender(
        state,
        () =>
          html`<ul>${each(
            read(m, (s) => s.rows),
            (_r: Row) =>
              html`<li ${classList({ done: itemBind((x: Row) => x.label) as unknown as boolean })}>x</li>`,
            { key: (r: Row) => r.id },
          )}</ul>`,
      ),
    ).toThrow(/class:list\/style:list spec/)
  })
})
