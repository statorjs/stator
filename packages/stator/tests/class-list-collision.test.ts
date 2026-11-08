import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
    assert.throws(
      comp('<button class="place-tab" class:list={{ active: on }}>x</button>'),
      /both a static `class`[\s\S]*class:list/,
    )
  })

  it('errors when class:list comes BEFORE the static class too (order-independent)', () => {
    assert.throws(
      comp('<button class:list={{ active: on }} class="place-tab">x</button>'),
      /class:list/,
    )
  })

  it('errors for static style + style:list', () => {
    assert.throws(
      comp('<div style="color:red" style:list={{ display: d }}>x</div>'),
      /both a static `style`[\s\S]*style:list/,
    )
  })

  it('allows a static class alone, or class:list alone', () => {
    assert.doesNotThrow(comp('<button class="place-tab">x</button>'))
    assert.doesNotThrow(comp("<button class:list={['place-tab', { active: false }]}>x</button>"))
  })
})
