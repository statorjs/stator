import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { statorDiagnostics } from '../src/diagnostics.ts'

describe('stator semantic diagnostics', () => {
  it('returns no diagnostics for a valid component', () => {
    const src = `<div class="ok"><p>hello</p></div>\n`
    assert.deepStrictEqual(statorDiagnostics(src, '/app/templates/ok.stator'), [])
  })

  it('returns no diagnostics for a valid route', () => {
    const src = [
      '---',
      "import Widget from '../templates/ok.stator'",
      '---',
      '<Widget />',
      '',
    ].join('\n')
    assert.deepStrictEqual(statorDiagnostics(src, '/app/routes/index.stator'), [])
  })

  it('flags route-only frontmatter used in a component', () => {
    const src = ['---', 'const [m] = Stator.reads([])', '---', '<div>x</div>', ''].join('\n')
    const [d] = statorDiagnostics(src, '/app/templates/widget.stator')
    assert.notEqual(d, undefined)
    assert.ok(d!.message.includes('Stator.reads'))
    assert.equal(d!.source, 'stator')
    assert.equal(d!.severity, 1)
    // Located inside the frontmatter (line 2 of the file → 0-based line 1).
    assert.equal(d!.range.start.line, 1)
  })

  it('flags an unknown pragma with a position', () => {
    const src = ['---', '// @stator turbo', '---', '<div>x</div>', ''].join('\n')
    const [d] = statorDiagnostics(src, '/app/routes/index.stator')
    assert.ok(d!.message.includes('unknown pragma'))
    assert.equal(d!.range.start.line, 1)
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
    assert.ok(d!.message.includes('StatorElement'))
  })

  it('routes decide their kind by path', () => {
    // `Stator.reads` is legal in routes/, so the same source is clean there.
    const src = ['---', 'const [m] = Stator.reads([])', '---', '<div>x</div>', ''].join('\n')
    assert.deepStrictEqual(statorDiagnostics(src, '/app/routes/page.stator'), [])
    assert.equal(statorDiagnostics(src, '/app/templates/page.stator').length, 1)
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
    assert.notEqual(d, undefined)
    assert.deepStrictEqual(d!.range.start, { line: 0, character: 0 })
    assert.equal(d!.severity, 1)
  })

  it('surfaces a compiler warning as a warning, not an error', () => {
    const src = [
      '---',
      "const json = '{}'",
      '---',
      '<head>{raw(`<script type="speculationrules">${json}</script>`)}</head>',
      '',
    ].join('\n')
    const ds = statorDiagnostics(src, '/app/templates/speculation.stator')
    assert.equal(ds.length, 1)
    assert.equal(ds[0]!.severity, 2)
    assert.ok(ds[0]!.message.includes('raw()'))
    assert.deepStrictEqual(ds[0]!.range.start, { line: 3, character: 11 })
  })
})
