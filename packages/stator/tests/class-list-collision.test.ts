import { describe, expect, it } from 'vitest'
import { compile } from '../src/compiler/compile.ts'

/**
 * Regression for FINDINGS #1 (spec: attribute-composition-on-an-element-is-
 * drop-not-merge). A static `class` alongside `class:list` (or `style` +
 * `style:list`) compiled to TWO `class` attributes; the browser keeps the first
 * and silently drops the other. Per the decision, this is now a compile-time
 * error — everything goes through the `:list`, which accepts a static string
 * alongside the dynamic parts.
 */

const comp = (src: string) => () => compile(src, { id: 'c.stator', kind: 'component' })

describe('static class/style + :list collision (FINDINGS #1)', () => {
  it('errors when an element has both a static class and class:list', () => {
    expect(comp('<button class="place-tab" class:list={{ active: on }}>x</button>')).toThrow(
      /both a static `class`[\s\S]*class:list/,
    )
  })

  it('errors when class:list comes BEFORE the static class too (order-independent)', () => {
    expect(comp('<button class:list={{ active: on }} class="place-tab">x</button>')).toThrow(
      /class:list/,
    )
  })

  it('errors for static style + style:list', () => {
    expect(comp('<div style="color:red" style:list={{ display: d }}>x</div>')).toThrow(
      /both a static `style`[\s\S]*style:list/,
    )
  })

  it('allows a static class alone, or class:list alone', () => {
    expect(comp('<button class="place-tab">x</button>')).not.toThrow()
    expect(comp("<button class:list={['place-tab', { active: false }]}>x</button>")).not.toThrow()
  })
})
