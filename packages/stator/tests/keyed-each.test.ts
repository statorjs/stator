// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { recompute } from '../src/server/recompute.ts'
import { createRenderState, keyToken, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { each, isSingleRootElement } from '../src/template/each.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'
import type { InstanceOf } from '../src/template/types.ts'
import { applyPatches } from '../src/wire/apply.ts'
import type { Patch } from '../src/wire/index.ts'

type Row = { id: string; label: string }

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
    selectors: {
      rows: (ctx) => ctx.rows,
    },
  })
}

async function buildRuntime(initial: Row[]) {
  const List = makeList()
  const store = new MachineStore([List], new InMemoryStore())
  store.bootAppMachines()
  const runtime = new SessionRuntime('s1', store)
  await runtime.loadGraph([List])
  runtime.processEvent('ListMachine', { type: 'SET', rows: initial })
  const list = runtime.proxyFor('ListMachine') as InstanceOf<ReturnType<typeof makeList>>
  const state = createRenderState('s1', 'GET /')
  return { runtime, list, state }
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, label: `label-${id}` }))

function renderKeyedList(
  state: ReturnType<typeof createRenderState>,
  list: InstanceOf<ReturnType<typeof makeList>>,
) {
  return runInRender(
    state,
    () =>
      html`<ul>${each(
        read(list, (l) => l.rows),
        (r) => html`<li>${r.label}</li>`,
        { key: (r) => r.id },
      )}</ul>`,
  )
}

/** Set the machine's rows and return the keyed patches for the change. */
function update(
  runtime: SessionRuntime,
  state: ReturnType<typeof createRenderState>,
  next: Row[],
): Patch[] {
  runtime.processEvent('ListMachine', { type: 'SET', rows: next })
  return recompute(state, 'ListMachine', runtime)
}

describe('keyed each: render', () => {
  it('renders items under key scopes, not positional scopes', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b'))
    try {
      const out = runInRender(
        state,
        () =>
          html`<ul>${each(
            read(list, (l) => l.rows),
            (r) =>
              html`<li>${read(list, (l) => l.rows.find((x) => x.id === r.id)?.label ?? '')}</li>`,
            { key: (r) => r.id },
          )}</ul>`,
      )
      expect(out.html).toContain('data-slot="s0:ka:s0"')
      expect(out.html).toContain('data-slot="s0:kb:s0"')
      expect(out.html).not.toContain(':i0:')
    } finally {
      runtime.dispose()
    }
  })

  it('coerces number keys and rejects other types', async () => {
    const { runtime, state } = await buildRuntime([])
    try {
      const numbered = runInRender(
        state,
        () =>
          html`<ul>${each([{ n: 1 }, { n: 2 }], (r) => html`<li>${r.n}</li>`, { key: (r) => r.n })}</ul>`,
      )
      expect(numbered.html).toContain('data-list="true"')

      expect(() =>
        runInRender(
          state,
          () =>
            html`<ul>${each([{ n: 1 }], (r) => html`<li>${r.n}</li>`, {
              key: (r) => r as unknown as string,
            })}</ul>`,
        ),
      ).toThrow(/must be a string or finite number/)
    } finally {
      runtime.dispose()
    }
  })

  it('rejects duplicate keys and multi-root items', async () => {
    const { runtime, state } = await buildRuntime([])
    try {
      expect(() =>
        runInRender(
          state,
          () =>
            html`<ul>${each(rows('a', 'a'), (r) => html`<li>${r.label}</li>`, { key: (r) => r.id })}</ul>`,
        ),
      ).toThrow(/duplicate key "a"/)

      expect(() =>
        runInRender(
          state,
          () =>
            html`<ul>${each(rows('a'), (r) => html`<li>${r.label}</li><li>x</li>`, { key: (r) => r.id })}</ul>`,
        ),
      ).toThrow(/exactly one root element/)
    } finally {
      runtime.dispose()
    }
  })

  it('encodes unsafe key characters into slot-id-safe tokens', () => {
    const token = keyToken('a b"c_d')
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    // Injective: the escape char itself is escaped.
    expect(keyToken('_62')).not.toBe(keyToken('b'))
  })
})

describe('keyed each: diff ops', () => {
  it('appends with a single insert', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b'))
    try {
      renderKeyedList(state, list)
      const patches = update(runtime, state, rows('a', 'b', 'c'))
      expect(patches).toEqual([
        {
          target: { kind: 'slot', id: 's0' },
          op: 'insert',
          index: 2,
          value: expect.stringContaining('label-c'),
        },
      ])
    } finally {
      runtime.dispose()
    }
  })

  it('removes with a single remove at the right index', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b', 'c'))
    try {
      renderKeyedList(state, list)
      const patches = update(runtime, state, rows('a', 'c'))
      expect(patches).toEqual([{ target: { kind: 'slot', id: 's0' }, op: 'remove', index: 1 }])
    } finally {
      runtime.dispose()
    }
  })

  it('reorders with moves, never re-rendering retained rows', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b', 'c'))
    try {
      renderKeyedList(state, list)
      const patches = update(runtime, state, rows('c', 'a', 'b'))
      expect(patches).toEqual([{ target: { kind: 'slot', id: 's0' }, op: 'move', from: 2, to: 0 }])
      expect(patches.some((p) => p.op === 'insert' || p.op === 'html')).toBe(false)
    } finally {
      runtime.dispose()
    }
  })

  it('replays to the correct final order for mixed changes', async () => {
    const before = ['a', 'b', 'c', 'd', 'e']
    const after = ['e', 'x', 'a', 'c', 'y']
    const { runtime, list, state } = await buildRuntime(rows(...before))
    try {
      renderKeyedList(state, list)
      const patches = update(runtime, state, rows(...after))

      // Simulate the client's sequential application over the key array.
      const dom = [...before]
      for (const p of patches) {
        if (p.op === 'remove') dom.splice(p.index, 1)
        else if (p.op === 'insert') {
          const m = p.value.match(/label-(\w+)/)!
          dom.splice(p.index, 0, m[1]!)
        } else if (p.op === 'move') {
          const [k] = dom.splice(p.from, 1)
          dom.splice(p.to, 0, k!)
        }
      }
      expect(dom).toEqual(after)
    } finally {
      runtime.dispose()
    }
  })

  it('no ops when only item content changes (keys stable)', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b'))
    try {
      renderKeyedList(state, list)
      const patches = update(runtime, state, [
        { id: 'a', label: 'renamed' },
        { id: 'b', label: 'label-b' },
      ])
      // Retained rows are never re-rendered by the keyed path; content
      // updates flow through nested bindings (next test).
      expect(patches).toEqual([])
    } finally {
      runtime.dispose()
    }
  })

  it('updates retained-row content via nested key-scoped bindings', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b'))
    try {
      runInRender(
        state,
        () =>
          html`<ul>${each(
            read(list, (l) => l.rows),
            (r) =>
              html`<li>${read(list, (l) => l.rows.find((x) => x.id === r.id)?.label ?? '')}</li>`,
            { key: (r) => r.id },
          )}</ul>`,
      )
      const patches = update(runtime, state, [
        { id: 'a', label: 'renamed' },
        { id: 'b', label: 'label-b' },
      ])
      expect(patches).toEqual([
        { target: { kind: 'slot', id: 's0:ka:s0' }, op: 'text', value: 'renamed' },
      ])
    } finally {
      runtime.dispose()
    }
  })

  it('subsumes pending patches for removed rows and unregisters their bindings', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b'))
    try {
      runInRender(
        state,
        () =>
          html`<ul>${each(
            read(list, (l) => l.rows),
            (r) =>
              html`<li>${read(list, (l) => l.rows.find((x) => x.id === r.id)?.label ?? '')}</li>`,
            { key: (r) => r.id },
          )}</ul>`,
      )
      expect(state.bindings.has('s0:ka:s0')).toBe(true)

      const patches = update(runtime, state, rows('b'))
      expect(patches).toEqual([{ target: { kind: 'slot', id: 's0' }, op: 'remove', index: 0 }])
      expect(state.bindings.has('s0:ka:s0')).toBe(false)
      expect(state.bindings.has('s0:kb:s0')).toBe(true)
    } finally {
      runtime.dispose()
    }
  })
})

describe('keyed each: DOM application (happy-dom)', () => {
  it('applies insert/remove/move sequentially and preserves node identity', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b', 'c'))
    try {
      const out = renderKeyedList(state, list)
      document.body.innerHTML = out.html
      const container = document.querySelector('[data-slot="s0"]')!
      const texts = () => Array.from(container.children).map((el) => el.textContent)
      expect(texts()).toEqual(['label-a', 'label-b', 'label-c'])

      const nodeB = container.children[1]!

      // Reorder + remove + insert in one change: c, b, x
      const patches = update(runtime, state, rows('c', 'b', 'x'))
      applyPatches(patches)

      expect(texts()).toEqual(['label-c', 'label-b', 'label-x'])
      // The b row is the SAME element after the shuffle — this is the
      // focus/transition-survival property, observable as node identity.
      expect(container.children[1]).toBe(nodeB)
    } finally {
      runtime.dispose()
    }
  })
})

describe('isSingleRootElement', () => {
  it('accepts single roots and rejects everything else', () => {
    expect(isSingleRootElement('<li>x</li>')).toBe(true)
    expect(isSingleRootElement('  <div a="<b>">nested <b>ok</b></div> ')).toBe(true)
    expect(isSingleRootElement('<img src="x">')).toBe(true)
    expect(isSingleRootElement('<!-- c --><li>x</li>')).toBe(true)
    expect(isSingleRootElement('<li>a</li><li>b</li>')).toBe(false)
    expect(isSingleRootElement('text')).toBe(false)
    expect(isSingleRootElement('<li>a</li> trailing')).toBe(false)
    expect(isSingleRootElement('')).toBe(false)
  })
})
