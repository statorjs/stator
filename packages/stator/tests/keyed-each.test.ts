// @env happy-dom
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
  await store.bootAppMachines()
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
      assert.ok(out.html.includes('data-slot="s0:ka:s0"'))
      assert.ok(out.html.includes('data-slot="s0:kb:s0"'))
      assert.ok(!out.html.includes(':i0:'))
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
      assert.ok(numbered.html.includes('<!--s:s0-->'))

      assert.throws(
        () =>
          runInRender(
            state,
            () =>
              html`<ul>${each([{ n: 1 }], (r) => html`<li>${r.n}</li>`, {
                key: (r) => r as unknown as string,
              })}</ul>`,
          ),
        /must be a string or finite number/,
      )
    } finally {
      runtime.dispose()
    }
  })

  it('rejects duplicate keys and multi-root items', async () => {
    const { runtime, state } = await buildRuntime([])
    try {
      assert.throws(
        () =>
          runInRender(
            state,
            () =>
              html`<ul>${each(rows('a', 'a'), (r) => html`<li>${r.label}</li>`, { key: (r) => r.id })}</ul>`,
          ),
        /duplicate key "a"/,
      )

      assert.throws(
        () =>
          runInRender(
            state,
            () =>
              html`<ul>${each(rows('a'), (r) => html`<li>${r.label}</li><li>x</li>`, { key: (r) => r.id })}</ul>`,
          ),
        /exactly one root element/,
      )
    } finally {
      runtime.dispose()
    }
  })

  it('encodes unsafe key characters into slot-id-safe tokens', () => {
    const token = keyToken('a b"c_d')
    assert.match(token, /^[A-Za-z0-9_-]+$/)
    // Injective: the escape char itself is escaped.
    assert.notEqual(keyToken('_62'), keyToken('b'))
  })
})

describe('keyed each: diff ops', () => {
  it('appends with a single insert', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b'))
    try {
      renderKeyedList(state, list)
      const patches = update(runtime, state, rows('a', 'b', 'c'))
      assert.equal(patches.length, 1)
      assert.partialDeepStrictEqual(patches[0], {
        target: { kind: 'slot', id: 's0' },
        op: 'insert',
        index: 2,
      })
      assert.ok(String((patches[0] as { value?: unknown }).value).includes('label-c'))
    } finally {
      runtime.dispose()
    }
  })

  it('removes with a single remove at the right index', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b', 'c'))
    try {
      renderKeyedList(state, list)
      const patches = update(runtime, state, rows('a', 'c'))
      assert.deepStrictEqual(patches, [
        { target: { kind: 'slot', id: 's0' }, op: 'remove', index: 1 },
      ])
    } finally {
      runtime.dispose()
    }
  })

  it('reorders with moves, never re-rendering retained rows', async () => {
    const { runtime, list, state } = await buildRuntime(rows('a', 'b', 'c'))
    try {
      renderKeyedList(state, list)
      const patches = update(runtime, state, rows('c', 'a', 'b'))
      assert.deepStrictEqual(patches, [
        { target: { kind: 'slot', id: 's0' }, op: 'move', from: 2, to: 0 },
      ])
      assert.equal(
        patches.some((p) => p.op === 'insert' || p.op === 'html'),
        false,
      )
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
      assert.deepStrictEqual(dom, after)
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
      assert.deepStrictEqual(patches, [])
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
      assert.deepStrictEqual(patches, [
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
      assert.equal(state.bindings.has('s0:ka:s0'), true)

      const patches = update(runtime, state, rows('b'))
      assert.deepStrictEqual(patches, [
        { target: { kind: 'slot', id: 's0' }, op: 'remove', index: 0 },
      ])
      assert.equal(state.bindings.has('s0:ka:s0'), false)
      assert.equal(state.bindings.has('s0:kb:s0'), true)
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
      // The region is delimited by comment markers now, not a wrapper element —
      // the rows are direct children of the <ul>, between the markers.
      const container = document.querySelector('ul')!
      const texts = () => Array.from(container.children).map((el) => el.textContent)
      assert.deepStrictEqual(texts(), ['label-a', 'label-b', 'label-c'])

      const nodeB = container.children[1]!

      // Reorder + remove + insert in one change: c, b, x
      const patches = update(runtime, state, rows('c', 'b', 'x'))
      applyPatches(patches)

      assert.deepStrictEqual(texts(), ['label-c', 'label-b', 'label-x'])
      // The b row is the SAME element after the shuffle — this is the
      // focus/transition-survival property, observable as node identity.
      assert.equal(container.children[1], nodeB)
    } finally {
      runtime.dispose()
    }
  })
})

describe('isSingleRootElement', () => {
  it('accepts single roots and rejects everything else', () => {
    assert.equal(isSingleRootElement('<li>x</li>'), true)
    assert.equal(isSingleRootElement('  <div a="<b>">nested <b>ok</b></div> '), true)
    assert.equal(isSingleRootElement('<img src="x">'), true)
    assert.equal(isSingleRootElement('<!-- c --><li>x</li>'), true)
    assert.equal(isSingleRootElement('<li>a</li><li>b</li>'), false)
    assert.equal(isSingleRootElement('text'), false)
    assert.equal(isSingleRootElement('<li>a</li> trailing'), false)
    assert.equal(isSingleRootElement(''), false)
  })
})
