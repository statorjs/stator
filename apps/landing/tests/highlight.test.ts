import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { highlight } from '../lib/highlight.ts'

const kinds = (code: string) =>
  highlight(code)
    .filter((t) => t.kind)
    .map((t) => `${t.kind}:${t.text}`)

describe('highlight', () => {
  it('loses nothing: the tokens join back to the source', () => {
    const code =
      "import { it } from 'node:test'\n\nit('a', () => {\n  // note\n  x.y(1, `t${a}`)\n})\n"
    assert.equal(
      highlight(code)
        .map((t) => t.text)
        .join(''),
      code,
    )
  })

  it('marks keywords, strings, calls, names, numbers and comments', () => {
    assert.deepEqual(kinds("import assert from 'node:assert/strict'"), [
      'keyword:import',
      'keyword:from',
      "string:'node:assert/strict'",
    ])
    assert.deepEqual(kinds('const a = createActor(CartMachine).start() // go'), [
      'keyword:const',
      'call:createActor',
      'name:CartMachine',
      'call:start',
      'comment:// go',
    ])
    assert.deepEqual(kinds("it('x', () => 42)"), ['call:it', "string:'x'", 'number:42'])
  })

  it('leaves a keyword inside a string or comment alone', () => {
    assert.deepEqual(kinds("'import from' // const"), ["string:'import from'", 'comment:// const'])
  })
})
