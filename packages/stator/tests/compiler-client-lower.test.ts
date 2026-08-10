import { describe, expect, it } from 'vitest'
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
    expect(inferDeps('qty.count', new Set(['qty']))).toEqual(['qty'])
    expect(inferDeps('qty.count + other.x', new Set(['qty', 'other']))).toEqual(['qty', 'other'])
  })
  it('ignores identifiers that are not use-fields', () => {
    expect(inferDeps('qty.count + 5', new Set(['qty']))).toEqual(['qty'])
    expect(inferDeps('localConst', new Set(['qty']))).toEqual([])
  })
})

describe('compiler: client-component lowering', () => {
  it('bind: is a located removal error pointing at read()', () => {
    expect(() => lowerClient('<span bind:text={qty.count}></span>', ['qty'])).toThrow(
      /bind:text was removed in 2\.0.*read\(\)/s,
    )
  })

  it('a client-machine read() in text position lowers to a slot marker', () => {
    const { shell, directives } = lowerClient('<span>{read(qty, (q) => q.count)}</span>', ['qty'])
    expect(shell).toBe('html`<span><!--s0--></span>`')
    expect(directives).toEqual([
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
    expect(shell).toBe('html`<button data-b="b0">+</button>`')
    expect(directives).toEqual([
      { marker: 'b0', kind: 'on', event: 'click', expr: 'inc', deps: [] },
    ])
  })

  it('groups multiple wirings on one element under one marker', () => {
    const { shell, directives } = lowerClient(
      '<button on:click={inc} disabled={read(qty, (q) => q.atMax)}>+</button>',
      ['qty'],
    )
    expect(shell).toBe('html`<button data-b="b0">+</button>`')
    expect(directives.map((d) => d.marker)).toEqual(['b0', 'b0'])
    expect(directives[1]).toMatchObject({
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
    expect(shell).toBe(
      'html`<div><button data-b="b0">-</button><span><!--s0--></span><button data-b="b1">+</button></div>`',
    )
    expect(directives.map((d) => d.marker)).toEqual(['b0', 's0', 'b1'])
  })

  it('keeps ref: (data-ref) alongside collected client wiring', () => {
    const { shell, directives } = lowerClient('<input ref:field on:change={commit} />', ['draft'])
    expect(shell).toBe('html`<input data-ref="field" data-b="b0" />`')
    expect(directives[0]).toMatchObject({ kind: 'on', event: 'change' })
  })

  it('leaves plain attributes and text untouched', () => {
    const { shell } = lowerClient('<button class="x" type="button" on:click={go}>Go</button>', [])
    expect(shell).toBe('html`<button class="x" type="button" data-b="b0">Go</button>`')
  })
})
