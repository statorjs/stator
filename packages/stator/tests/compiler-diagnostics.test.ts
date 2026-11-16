import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compile } from '../src/compiler/compile.ts'
import { CompileError, codeFrame, offsetToLineCol } from '../src/compiler/diagnostics.ts'

describe('compiler: diagnostics', () => {
  it('offsetToLineCol returns 1-based line/column', () => {
    const src = 'ab\ncde\nf'
    assert.deepStrictEqual(offsetToLineCol(src, 0), { line: 1, column: 1 })
    assert.deepStrictEqual(offsetToLineCol(src, 1), { line: 1, column: 2 })
    assert.deepStrictEqual(offsetToLineCol(src, 3), { line: 2, column: 1 }) // first char of line 2
    assert.deepStrictEqual(offsetToLineCol(src, 5), { line: 2, column: 3 })
    assert.deepStrictEqual(offsetToLineCol(src, 7), { line: 3, column: 1 })
  })

  it('codeFrame marks the offending line with a caret', () => {
    const src = 'line one\nline two\nline three'
    const frame = codeFrame(src, 2, 6)
    assert.ok(frame.includes('> 2 | line two'))
    assert.ok(frame.includes('^'))
  })

  it('locates an unsupported directive at the right line/column in the original .stator', () => {
    // bind: was removed in 2.0 — it should throw a LOCATED error with guidance.
    const src = `---
const x = 1
---
<div>
  <span bind:text={x}></span>
</div>`
    try {
      compile(src, { id: 'comp.stator' })
      throw new Error('expected compile to throw')
    } catch (e) {
      assert.ok(e instanceof CompileError)
      const err = e as CompileError
      assert.notEqual(err.loc, undefined)
      // `<span` is on line 5 of the original file.
      assert.equal(err.loc!.line, 5)
      assert.equal(err.loc!.file, 'comp.stator')
      assert.ok(err.loc!.frame.includes('bind:text'))
    }
  })

  it('locates a directive error in a template with no frontmatter', () => {
    const src = `<p>hi</p>\n<button on:click></button>`
    try {
      compile(src)
      throw new Error('expected throw')
    } catch (e) {
      const err = e as CompileError
      assert.equal(err.loc!.line, 2) // the <button> line
    }
  })
})

describe('compiler: defer/machine boundary (build-time gate)', () => {
  it('rejects a read() directly inside a defer arm, located at the read', () => {
    const src = `<main>
  {defer(() => db.get(1), { ready: () => <span>{read(cart, c => c.total)}</span> })}
</main>`
    try {
      compile(src, { id: 'p.stator' })
      throw new Error('expected compile to throw')
    } catch (e) {
      assert.ok(e instanceof CompileError)
      const err = e as CompileError
      assert.ok(err.message.includes('defer() arm'))
      assert.equal(err.loc!.line, 2) // the read() is on line 2
      assert.ok(err.loc!.frame.includes('read(cart'))
    }
  })

  it('rejects a read() reached through a machine-bound when() inside a defer arm', () => {
    const src = `<main>
  {defer(() => db.get(1), {
    ready: () => <div>{when(read(cart, c => c.open), () => <p>open</p>)}</div>,
  })}
</main>`
    assert.throws(() => compile(src, { id: 'p.stator' }), /defer\(\) arm/)
  })

  it('allows a read() as a SIBLING of a defer (the correct composition)', () => {
    const src = `<main>
  <span>{read(cart, c => c.total)}</span>
  {defer(() => db.get(1), { ready: (v) => <p>{v}</p> })}
</main>`
    assert.doesNotThrow(() => compile(src, { id: 'p.stator' }))
  })
})

describe('RCDATA placement gate', () => {
  it('rejects read() inside <textarea> — the slot wrapper would render as literal text', () => {
    assert.throws(
      () =>
        compile(
          `---\nimport M from '../machines/m.ts'\nconst [m] = Stator.reads([M])\n---\n<textarea>{read(m, (x) => x.draft)}</textarea>`,
          { id: 'routes/t.stator', kind: 'route' },
        ),
      /cannot appear inside <textarea>/,
    )
  })

  it('rejects each() inside <title>; attribute reads on the element stay legal', () => {
    assert.throws(
      () =>
        compile(
          `---\nimport M from '../machines/m.ts'\nconst [m] = Stator.reads([M])\n---\n<title>{each(read(m, (x) => x.items), (i) => i)}</title>`,
          { id: 'routes/t.stator', kind: 'route' },
        ),
      /cannot appear inside <title>/,
    )
    assert.doesNotThrow(() =>
      compile(
        `---\nimport M from '../machines/m.ts'\nconst [m] = Stator.reads([M])\n---\n<textarea placeholder={read(m, (x) => x.hint)}></textarea>`,
        { id: 'routes/t.stator', kind: 'route' },
      ),
    )
  })
})

describe('compiler: Stator markers outside the frontmatter', () => {
  const located = (src: string, kind: 'route' | 'component'): CompileError => {
    try {
      compile(src, { id: 'page.stator', kind })
    } catch (e) {
      assert.ok(e instanceof CompileError)
      return e
    }
    throw new Error('expected compile to throw')
  }

  it('rejects Stator.request interpolated in route markup, located at the marker', () => {
    const err = located(
      `---
const title = 'Search'
---
<h1>{title}</h1>
<p>{Stator.request.query.get('q')}</p>`,
      'route',
    )
    assert.match(
      err.message,
      /Stator\.request .*frontmatter.*Assign it to a const in the frontmatter/,
    )
    assert.equal(err.loc!.file, 'page.stator')
    assert.equal(err.loc!.line, 5)
    assert.equal(err.loc!.column, 5)
    assert.ok(err.loc!.frame.includes("{Stator.request.query.get('q')}"))
  })

  it('rejects a marker in a route prop expression', () => {
    const err = located(
      `---
import Form from '../templates/form.stator'
---
<Form query={Stator.request.query} />`,
      'route',
    )
    assert.match(err.message, /Assign it to a const in the frontmatter/)
    assert.equal(err.loc!.line, 4)
    assert.equal(err.loc!.column, 14)
  })

  it('rejects a marker in a directive value', () => {
    const err = located(`<button on:click={() => Stator.response}>x</button>`, 'route')
    assert.match(err.message, /Stator\.response/)
  })

  it('rejects a route-only marker used only in component markup, with component guidance', () => {
    const err = located(`<p>{Stator.request.url.pathname}</p>`, 'component')
    assert.match(err.message, /only available in a route page.*pass the value down as a prop/)
    assert.equal(err.loc!.line, 1)
    assert.equal(err.loc!.column, 5)
  })

  it('does not flag "Stator." in text, string literals or other identifiers', () => {
    const src = `---
const stator = { request: 'x' }
const label = 'Stator.request'
---
<p title="Stator.request">Read Stator.request in the frontmatter.</p>
<p>{'Stator.response'} {\`Stator.reads\`} {label} {stator.request}</p>`
    assert.doesNotThrow(() => compile(src, { id: 'page.stator', kind: 'route' }))
    assert.doesNotThrow(() => compile(src, { id: 'comp.stator', kind: 'component' }))
  })
})
