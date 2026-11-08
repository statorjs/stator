import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type ClientDirective, inferDeps } from '../src/compiler/client-script.ts'
import { type LowerMeta, lowerTemplate } from '../src/compiler/lower.ts'

function meta(): LowerMeta {
  return {
    usesChildren: false,
    regions: new Set(),
    components: new Set(),
    customElements: new Set(),
    refs: new Set(),
  }
}

function lowerClient(template: string, useFields: string[]) {
  const directives: ClientDirective[] = []
  const shell = lowerTemplate(template, {
    meta: meta(),
    client: { useFields: new Set(useFields), directives },
  })
  return { shell, directives }
}

describe('compiler: inferDeps', () => {
  it('extracts use-field object references, not property names', () => {
    assert.deepStrictEqual(inferDeps('qty.count', new Set(['qty'])), ['qty'])
    assert.deepStrictEqual(inferDeps('qty.count + other.x', new Set(['qty', 'other'])), [
      'qty',
      'other',
    ])
  })
  it('ignores identifiers that are not use-fields', () => {
    assert.deepStrictEqual(inferDeps('qty.count + 5', new Set(['qty'])), ['qty'])
    assert.deepStrictEqual(inferDeps('localConst', new Set(['qty'])), [])
  })
})

describe('compiler: client-component lowering', () => {
  it('bind: is a located removal error pointing at read()', () => {
    assert.throws(
      () => lowerClient('<span bind:text={qty.count}></span>', ['qty']),
      /bind:text was removed in 2\.0.*read\(\)/s,
    )
  })

  it('a client-machine read() in text position lowers to a slot marker', () => {
    const { shell, directives } = lowerClient('<span>{read(qty, (q) => q.count)}</span>', ['qty'])
    assert.equal(shell, 'html`<span><!--s0--></span>`')
    assert.deepStrictEqual(directives, [
      {
        marker: 's0',
        kind: 'slot',
        expr: '((q) => q.count)(qty)',
        deps: ['qty'],
      },
    ])
  })

  it('collects on: handlers (no deps) and strips them', () => {
    const { shell, directives } = lowerClient('<button on:click={inc}>+</button>', ['qty'])
    assert.equal(shell, 'html`<button data-b="b0">+</button>`')
    assert.deepStrictEqual(directives, [
      { marker: 'b0', kind: 'on', event: 'click', expr: 'inc', deps: [] },
    ])
  })

  it('groups multiple wirings on one element under one marker', () => {
    const { shell, directives } = lowerClient(
      '<button on:click={inc} disabled={read(qty, (q) => q.atMax)}>+</button>',
      ['qty'],
    )
    assert.equal(shell, 'html`<button data-b="b0">+</button>`')
    assert.deepStrictEqual(
      directives.map((d) => d.marker),
      ['b0', 'b0'],
    )
    assert.partialDeepStrictEqual(directives[1], {
      kind: 'bind',
      target: 'disabled',
      deps: ['qty'],
    })
  })

  it('assigns sequential element markers, with slots in their own namespace', () => {
    const { shell, directives } = lowerClient(
      '<div><button on:click={dec}>-</button><span>{read(qty, (q) => q.count)}</span><button on:click={inc}>+</button></div>',
      ['qty'],
    )
    assert.equal(
      shell,
      'html`<div><button data-b="b0">-</button><span><!--s0--></span><button data-b="b1">+</button></div>`',
    )
    assert.deepStrictEqual(
      directives.map((d) => d.marker),
      ['b0', 's0', 'b1'],
    )
  })

  it('keeps ref: (data-ref) alongside collected client wiring', () => {
    const { shell, directives } = lowerClient('<input ref:field on:change={commit} />', ['draft'])
    assert.equal(shell, 'html`<input data-ref="field" data-b="b0">`')
    assert.partialDeepStrictEqual(directives[0], { kind: 'on', event: 'change' })
  })

  it('leaves plain attributes and text untouched', () => {
    const { shell } = lowerClient('<button class="x" type="button" on:click={go}>Go</button>', [])
    assert.equal(shell, 'html`<button class="x" type="button" data-b="b0">Go</button>`')
  })
})
