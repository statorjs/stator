// @env happy-dom
// A keyed alerts table: per-cell text and attr item bindings through
// `rowsByKey`, applied to a real DOM so each update is checked for convergence
// (the DOM matches the new state) and for granularity (the patch ops emitted).
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
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
import { applyPatches } from '../src/wire/apply.ts'
import type { Patch } from '../src/wire/index.ts'

type Alert = {
  id: string
  robot: string
  rule: string
  severity: 'low' | 'high'
  status: 'raised' | 'cleared'
  reason: string
}

function makeAlerts() {
  return defineMachine({
    name: 'AlertsTable',
    lifecycle: 'session',
    events: {} as { type: 'SET'; alerts: Alert[] },
    context: { alerts: [] as Alert[] },
    initial: 'idle',
    states: {
      idle: {
        on: {
          SET: (ctx, ev) => {
            ctx.alerts = ev.alerts
          },
        },
      },
    },
    selectors: { alerts: (ctx) => ctx.alerts },
  })
}

type Table = {
  runtime: SessionRuntime
  state: ReturnType<typeof createRenderState>
  tbody: HTMLTableSectionElement
  rowFor: Map<string, Element>
}

let current: Table | undefined

afterEach(() => {
  current?.runtime.dispose()
  current = undefined
})

// Mirrors what the compiler lowers `read(alert, (a) => a.field)` to in each position.
async function mount(initial: Alert[]): Promise<Table> {
  const Alerts = makeAlerts()
  const store = new MachineStore([Alerts], new InMemoryStore())
  await store.bootAppMachines()
  const runtime = new SessionRuntime('s1', store)
  await runtime.loadGraph([Alerts])
  runtime.processEvent('AlertsTable', { type: 'SET', alerts: initial })
  const alerts = runtime.proxyFor('AlertsTable') as InstanceOf<ReturnType<typeof makeAlerts>>
  const state = createRenderState('s1', 'GET /alerts')

  const out = runInRender(
    state,
    () =>
      html`<table><tbody>${each(
        read(alerts, (m) => m.alerts),
        (a: Alert) =>
          html`<tr data-key="${a.id}" class="${itemBind((x: Alert) => x.status)}"><td>${itemBind(
            (x: Alert) => x.robot,
          )}</td><td>${itemBind((x: Alert) => x.rule)}</td><td data-severity="${itemBind(
            (x: Alert) => x.severity,
          )}">${itemBind((x: Alert) => x.severity)}</td><td>${itemBind(
            (x: Alert) => x.reason,
          )}</td></tr>`,
        { key: (a: Alert) => a.id },
      )}</tbody></table>`,
  )
  document.body.innerHTML = out.html
  const tbody = document.querySelector('tbody')!
  const rowFor = new Map(
    Array.from(tbody.children).map((tr) => [tr.getAttribute('data-key')!, tr] as const),
  )
  current = { runtime, state, tbody, rowFor }
  return current
}

function update(t: Table, next: Alert[]): Patch[] {
  t.runtime.processEvent('AlertsTable', { type: 'SET', alerts: next })
  const patches = recompute(t.state, 'AlertsTable', t.runtime)
  applyPatches(patches)
  return patches
}

/** The table as the DOM shows it, in the same shape as the state. */
function domRows(t: Table): Alert[] {
  return Array.from(t.tbody.children).map((tr) => {
    const cells = Array.from(tr.children).map((td) => td.textContent ?? '')
    return {
      id: tr.getAttribute('data-key')!,
      robot: cells[0]!,
      rule: cells[1]!,
      severity: tr.children[2]!.getAttribute('data-severity') as Alert['severity'],
      status: tr.getAttribute('class') as Alert['status'],
      reason: cells[3]!,
    }
  })
}

/** Asserts the DOM converged and every surviving row is the element it started as. */
function assertConverged(t: Table, expected: Alert[]): void {
  assert.deepStrictEqual(domRows(t), expected)
  for (const tr of Array.from(t.tbody.children)) {
    const key = tr.getAttribute('data-key')!
    const original = t.rowFor.get(key)
    if (original) assert.equal(tr, original, `row ${key} was replaced, not patched`)
    else t.rowFor.set(key, tr)
  }
}

const ops = (patches: Patch[]) => patches.map((p) => p.op).sort()

const alert = (id: string, over: Partial<Alert> = {}): Alert => ({
  id,
  robot: `robot-${id.split('/')[0]}`,
  rule: `rule-${id.split('/')[1]}`,
  severity: 'low',
  status: 'raised',
  reason: 'battery below 20%',
  ...over,
})

const seed = () => [alert('r1/battery'), alert('r2/battery'), alert('r3/offline')]

describe('keyed table: fine-grained updates via rowsByKey', () => {
  it('a single cell change emits one text patch for that cell', async () => {
    const t = await mount(seed())
    const next = seed()
    next[1] = { ...next[1]!, reason: 'battery below 10%' }
    const patches = update(t, next)
    assert.deepStrictEqual(ops(patches), ['text'])
    assert.equal((patches[0] as { value: string }).value, 'battery below 10%')
    assertConverged(t, next)
  })

  it('an attribute cell change emits one attr patch', async () => {
    const t = await mount(seed())
    const next = seed()
    next[2] = { ...next[2]!, status: 'cleared' }
    const patches = update(t, next)
    assert.deepStrictEqual(ops(patches), ['attr'])
    assert.equal((patches[0] as { name: string }).name, 'class')
    assertConverged(t, next)
  })

  it('a whole-row change patches every cell of that row and nothing else', async () => {
    const t = await mount(seed())
    const next = seed()
    next[0] = {
      id: 'r1/battery',
      robot: 'robot-1 (dock)',
      rule: 'rule-battery-v2',
      severity: 'high',
      status: 'cleared',
      reason: 'charging',
    }
    const patches = update(t, next)
    // robot, rule, severity text, reason + class, data-severity.
    assert.deepStrictEqual(ops(patches), ['attr', 'attr', 'text', 'text', 'text', 'text'])
    const rowIds = new Set(
      Array.from(t.rowFor.get('r1/battery')!.querySelectorAll('[data-slot],[data-stator-id]'))
        .concat(t.rowFor.get('r1/battery')!)
        .map((el) => el.getAttribute('data-slot') ?? el.getAttribute('data-stator-id')),
    )
    for (const p of patches) assert.ok(rowIds.has(p.target.id), `patch ${p.target.id} left the row`)
    assertConverged(t, next)
  })

  it('reordering emits only moves and keeps every row element', async () => {
    const t = await mount(seed())
    const next = [...seed()].reverse()
    const patches = update(t, next)
    assert.ok(patches.length > 0)
    assert.ok(patches.every((p) => p.op === 'move'))
    assertConverged(t, next)
  })

  it('adding and removing rows emits insert and remove, never a table re-render', async () => {
    const t = await mount(seed())
    const next = [alert('r1/battery'), alert('r3/offline'), alert('r4/offline')]
    const patches = update(t, next)
    assert.deepStrictEqual(ops(patches), ['insert', 'remove'])
    assertConverged(t, next)
  })

  it('a row added after the first render is patched cell by cell later', async () => {
    const t = await mount(seed())
    update(t, [...seed(), alert('r4/offline')])
    const next = [...seed(), alert('r4/offline', { severity: 'high' })]
    const patches = update(t, next)
    assert.deepStrictEqual(ops(patches), ['attr', 'text'])
    assertConverged(t, next)
  })

  it('a removed key that returns renders fresh and is patchable again', async () => {
    const t = await mount(seed())
    update(t, [alert('r1/battery'), alert('r3/offline')])
    t.rowFor.delete('r2/battery')
    const back = [alert('r1/battery'), alert('r2/battery', { reason: 'back' }), alert('r3/offline')]
    assert.deepStrictEqual(ops(update(t, back)), ['insert'])
    assertConverged(t, back)
    const next = back.map((a) => (a.id === 'r2/battery' ? { ...a, reason: 'gone again' } : a))
    assert.deepStrictEqual(ops(update(t, next)), ['text'])
    assertConverged(t, next)
  })

  it('reorder, cell edits, add and remove in one update converge together', async () => {
    const t = await mount([...seed(), alert('r4/offline'), alert('r5/battery')])
    // Sorted by severity: r5 escalates to the top, r3 clears, r2 and r4 go, r6 arrives.
    const next = [
      alert('r5/battery', { severity: 'high', reason: 'battery below 5%' }),
      alert('r6/offline', { severity: 'high', reason: 'no heartbeat' }),
      alert('r1/battery'),
      alert('r3/offline', { status: 'cleared' }),
    ]
    const patches = update(t, next)
    assert.equal(
      patches.some((p) => p.op === 'html'),
      false,
    )
    const count = (op: Patch['op']) => patches.filter((p) => p.op === op).length
    assert.equal(count('remove'), 2)
    assert.equal(count('insert'), 1)
    assert.ok(count('move') >= 1)
    // r5: severity text + reason text + data-severity attr; r3: class attr.
    assert.equal(count('text'), 2)
    assert.equal(count('attr'), 2)
    assertConverged(t, next)
  })

  it('identity churn with unchanged content emits nothing', async () => {
    const t = await mount(seed())
    assert.deepStrictEqual(update(t, seed()), [])
    assertConverged(t, seed())
  })
})
