import { describe, expect, it } from 'vitest'
import { statorDiagnostics } from '../src/diagnostics.ts'

describe('stator semantic diagnostics', () => {
  it('returns no diagnostics for a valid component', () => {
    const src = `<div class="ok"><p>hello</p></div>\n`
    expect(statorDiagnostics(src, '/app/templates/ok.stator')).toEqual([])
  })

  it('returns no diagnostics for a valid route', () => {
    const src = [
      '---',
      "import Widget from '../templates/ok.stator'",
      '---',
      '<Widget />',
      '',
    ].join('\n')
    expect(statorDiagnostics(src, '/app/routes/index.stator')).toEqual([])
  })

  it('flags route-only frontmatter used in a component', () => {
    const src = ['---', 'const [m] = Stator.reads([])', '---', '<div>x</div>', ''].join('\n')
    const [d] = statorDiagnostics(src, '/app/templates/widget.stator')
    expect(d).toBeDefined()
    expect(d!.message).toContain('Stator.reads')
    expect(d!.source).toBe('stator')
    expect(d!.severity).toBe(1)
    // Located inside the frontmatter (line 2 of the file → 0-based line 1).
    expect(d!.range.start.line).toBe(1)
  })

  it('flags an unknown pragma with a position', () => {
    const src = ['---', '// @stator turbo', '---', '<div>x</div>', ''].join('\n')
    const [d] = statorDiagnostics(src, '/app/routes/index.stator')
    expect(d!.message).toContain('unknown pragma')
    expect(d!.range.start.line).toBe(1)
  })

  it('flags a <script> without a StatorElement subclass', () => {
    const src = [
      '<my-widget><p>x</p></my-widget>',
      '',
      '<script>',
      'const x = 1',
      '</script>',
      '',
    ].join('\n')
    const [d] = statorDiagnostics(src, '/app/templates/my-widget.stator')
    expect(d!.message).toContain('StatorElement')
  })

  it('routes decide their kind by path', () => {
    // `Stator.reads` is legal in routes/, so the same source is clean there.
    const src = ['---', 'const [m] = Stator.reads([])', '---', '<div>x</div>', ''].join('\n')
    expect(statorDiagnostics(src, '/app/routes/page.stator')).toEqual([])
    expect(statorDiagnostics(src, '/app/templates/page.stator')).toHaveLength(1)
  })

  it('anchors coarse-location errors at the top of the file instead of dropping them', () => {
    // Client tag↔class name mismatches only know the file, not a token —
    // they surface at 0:0 rather than disappearing.
    const src = [
      '<my-widget><p>x</p></my-widget>',
      '',
      '<script>',
      'export class SomethingElse extends StatorElement {}',
      '</script>',
      '',
    ].join('\n')
    const [d] = statorDiagnostics(src, '/app/templates/my-widget.stator')
    expect(d).toBeDefined()
    expect(d!.range.start).toEqual({ line: 0, character: 0 })
    expect(d!.severity).toBe(1)
  })
})
