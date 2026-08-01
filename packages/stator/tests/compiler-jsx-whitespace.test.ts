import { describe, expect, it } from 'vitest'
import { lowerTemplate } from '../src/compiler/lower.ts'

// JSX text whitespace: inline spaces around an expression are significant and
// preserved (matching JSX), while newlines + indentation between tags collapse.
// Regression for `{count} unsaved` rendering as `{count}unsaved` — `getText()`
// skipped the text node's leading trivia, dropping the space after an expr.

describe('lower: JSX text whitespace', () => {
  it('preserves an inline space AFTER an expression', () => {
    expect(lowerTemplate('<span>{x} unsaved</span>')).toBe('html`<span>${x} unsaved</span>`')
  })

  it('preserves an inline space BEFORE an expression', () => {
    expect(lowerTemplate('<span>Total: {x}</span>')).toBe('html`<span>Total: ${x}</span>`')
  })

  it('preserves spaces on BOTH sides of an expression', () => {
    expect(lowerTemplate('<span>a {x} b</span>')).toBe('html`<span>a ${x} b</span>`')
    expect(lowerTemplate('<span>{a} of {b}</span>')).toBe('html`<span>${a} of ${b}</span>`')
  })

  it('does not invent a space between adjacent expressions', () => {
    expect(lowerTemplate('<span>{a}{b}</span>')).toBe('html`<span>${a}${b}</span>`')
  })

  it('collapses newlines + indentation between tags (JSX rule)', () => {
    expect(lowerTemplate('<div>\n  <span>{x}</span>\n</div>')).toBe(
      'html`<div><span>${x}</span></div>`',
    )
  })

  it('collapses a newline inside text to a single space', () => {
    expect(lowerTemplate('<span>hello\n  world</span>')).toBe('html`<span>hello world</span>`')
  })
})
