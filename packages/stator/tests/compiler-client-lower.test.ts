import { describe, it, expect } from 'vitest'
import { lowerTemplate, type LowerMeta } from '../src/compiler/lower.ts'
import { inferDeps, type ClientDirective } from '../src/compiler/client-script.ts'

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
  it('collects bind: with inferred deps, strips it, injects a node marker', () => {
    const { shell, directives } = lowerClient('<span bind:text={qty.count}></span>', ['qty'])
    expect(shell).toBe('html`<span data-b="b0"></span>`')
    expect(directives).toEqual([
      { marker: 'b0', kind: 'bind', target: 'text', expr: 'qty.count', deps: ['qty'] },
    ])
  })

  it('collects on: handlers (no deps) and strips them', () => {
    const { shell, directives } = lowerClient('<button on:click={inc}>+</button>', ['qty'])
    expect(shell).toBe('html`<button data-b="b0">+</button>`')
    expect(directives).toEqual([
      { marker: 'b0', kind: 'on', event: 'click', expr: 'inc', deps: [] },
    ])
  })

  it('groups multiple directives on one element under one marker', () => {
    const { shell, directives } = lowerClient(
      '<button on:click={inc} bind:disabled={qty.atMax}>+</button>',
      ['qty'],
    )
    expect(shell).toBe('html`<button data-b="b0">+</button>`')
    expect(directives.map((d) => d.marker)).toEqual(['b0', 'b0'])
    expect(directives[1]).toMatchObject({ kind: 'bind', target: 'disabled', deps: ['qty'] })
  })

  it('assigns sequential markers across elements', () => {
    const { shell, directives } = lowerClient(
      '<div><button on:click={dec}>-</button><span bind:text={qty.count}></span><button on:click={inc}>+</button></div>',
      ['qty'],
    )
    expect(shell).toBe(
      'html`<div><button data-b="b0">-</button><span data-b="b1"></span><button data-b="b2">+</button></div>`',
    )
    expect(directives.map((d) => d.marker)).toEqual(['b0', 'b1', 'b2'])
  })

  it('keeps ref: (data-ref) alongside collected client directives', () => {
    const { shell, directives } = lowerClient(
      '<input ref:field bind:value={draft.q} />',
      ['draft'],
    )
    expect(shell).toBe('html`<input data-ref="field" data-b="b0" />`')
    expect(directives[0]).toMatchObject({ kind: 'bind', target: 'value', deps: ['draft'] })
  })

  it('leaves plain attributes and text untouched', () => {
    const { shell } = lowerClient('<button class="x" type="button" on:click={go}>Go</button>', [])
    expect(shell).toBe('html`<button class="x" type="button" data-b="b0">Go</button>`')
  })
})
