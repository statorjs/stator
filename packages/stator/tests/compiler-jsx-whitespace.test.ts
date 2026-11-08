import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { lowerTemplate } from '../src/compiler/lower.ts'

// JSX text whitespace: inline spaces around an expression are significant and
// preserved (matching JSX), while newlines + indentation between tags collapse.
// Regression for `{count} unsaved` rendering as `{count}unsaved` — `getText()`
// skipped the text node's leading trivia, dropping the space after an expr.

describe('lower: JSX text whitespace', () => {
  it('preserves an inline space AFTER an expression', () => {
    assert.equal(lowerTemplate('<span>{x} unsaved</span>'), 'html`<span>${x} unsaved</span>`')
  })

  it('preserves an inline space BEFORE an expression', () => {
    assert.equal(lowerTemplate('<span>Total: {x}</span>'), 'html`<span>Total: ${x}</span>`')
  })

  it('preserves spaces on BOTH sides of an expression', () => {
    assert.equal(lowerTemplate('<span>a {x} b</span>'), 'html`<span>a ${x} b</span>`')
    assert.equal(lowerTemplate('<span>{a} of {b}</span>'), 'html`<span>${a} of ${b}</span>`')
  })

  it('does not invent a space between adjacent expressions', () => {
    assert.equal(lowerTemplate('<span>{a}{b}</span>'), 'html`<span>${a}${b}</span>`')
  })

  it('collapses newlines + indentation between tags (JSX rule)', () => {
    assert.equal(
      lowerTemplate('<div>\n  <span>{x}</span>\n</div>'),
      'html`<div><span>${x}</span></div>`',
    )
  })

  it('collapses a newline inside text to a single space', () => {
    assert.equal(lowerTemplate('<span>hello\n  world</span>'), 'html`<span>hello world</span>`')
  })
})
