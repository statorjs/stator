import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { transform } from 'esbuild'
import { CompileError, compile } from '../src/compiler/index.ts'
import type { SourceMapV3 } from '../src/compiler/source-map.ts'

const ROUTE = `---

import { helper } from './helper.ts'
type Row = { name: string }

const rows: Row[] = [
  { name: 'a' },
  { name: 'b' },
]
const title = rows.map((r) => r.name).join(', ')
---
<html>
  <head>
    <script is:inline>window.x = { a: 1 }</script>
  </head>
  <body>
    <h1>{title.toUpperCase()}</h1>
    <ul>{rows.map((r) => <li>{r.name}</li>)}</ul>
    <Card label={helper(title)} />
  </body>
</html>
`

/** Decode a V3 `mappings` string into [genLine, genCol, srcLine, srcCol] tuples. */
function decode(mappings: string): Array<[number, number, number, number]> {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const out: Array<[number, number, number, number]> = []
  let srcLine = 0
  let srcCol = 0
  mappings.split(';').forEach((line, genLine) => {
    let genCol = 0
    for (const seg of line ? line.split(',') : []) {
      const fields: number[] = []
      let v = 0
      let shift = 0
      for (const ch of seg) {
        const d = B64.indexOf(ch)
        v += (d & 31) << shift
        if (d & 32) shift += 5
        else {
          fields.push(v & 1 ? -(v >>> 1) : v >>> 1)
          v = 0
          shift = 0
        }
      }
      genCol += fields[0]!
      srcLine += fields[2]!
      srcCol += fields[3]!
      out.push([genLine, genCol, srcLine, srcCol])
    }
  })
  return out
}

/** Where `needle`'s first occurrence in `code` maps, by the nearest preceding segment. */
function sourceOf(code: string, map: SourceMapV3, needle: string): { line: number; col: number } {
  const at = code.indexOf(needle)
  assert.notEqual(at, -1, needle)
  const genLine = code.slice(0, at).split('\n').length - 1
  const genCol = at - (code.lastIndexOf('\n', at - 1) + 1)
  const seg = decode(map.mappings)
    .filter(([l, c]) => l === genLine && c <= genCol)
    .at(-1)
  assert.ok(seg, `no mapping before ${needle}`)
  return { line: seg[2], col: seg[3] + (genCol - seg[1]) }
}

/** 0-based line/col of `needle` in the source. */
function inSource(needle: string): { line: number; col: number } {
  const at = ROUTE.indexOf(needle)
  assert.notEqual(at, -1, needle)
  return {
    line: ROUTE.slice(0, at).split('\n').length - 1,
    col: at - (ROUTE.lastIndexOf('\n', at - 1) + 1),
  }
}

describe('compiler source maps', () => {
  const plain = compile(ROUTE, { id: 'routes/index.stator', kind: 'route' })
  const mapped = compile(ROUTE, {
    id: 'routes/index.stator',
    kind: 'route',
    sourceMap: { source: '/app/routes/index.stator' },
  })

  it('changes nothing but the trailing map comment', () => {
    const [code, comment] = mapped.serverCode.split(/(?=\/\/# sourceMappingURL=)/)
    assert.equal(code, plain.serverCode)
    assert.ok(comment)
    assert.match(comment, /^\/\/# sourceMappingURL=data:application\/json;base64,/)
    assert.equal(plain.map, undefined)
  })

  it('names the source and carries its content', () => {
    assert.ok(mapped.map)
    assert.deepStrictEqual(mapped.map.sources, ['/app/routes/index.stator'])
    assert.deepStrictEqual(mapped.map.sourcesContent, [ROUTE])
  })

  it('maps frontmatter line for line, including statements that span lines', () => {
    assert.ok(mapped.map)
    for (const needle of [
      "import { helper } from './helper.ts'",
      "{ name: 'b' }",
      'rows.map((r) => r.name)',
    ]) {
      assert.deepStrictEqual(
        sourceOf(mapped.serverCode, mapped.map, needle),
        inSource(needle),
        needle,
      )
    }
  })

  it('maps template expressions and component calls past an inline script', () => {
    assert.ok(mapped.map)
    assert.deepStrictEqual(
      sourceOf(mapped.serverCode, mapped.map, 'title.toUpperCase()'),
      inSource('title.toUpperCase()'),
    )
    assert.deepStrictEqual(sourceOf(mapped.serverCode, mapped.map, 'r.name}'), inSource('r.name}'))
    assert.deepStrictEqual(
      sourceOf(mapped.serverCode, mapped.map, 'helper(title)'),
      inSource('helper(title)'),
    )
  })

  it('a stack trace through esbuild names the .stator line', async () => {
    const src = `---\nconst boom = (): string => {\n  throw new Error('boom')\n}\n---\n<p>{boom()}</p>\n`
    const dir = mkdtempSync(join(tmpdir(), 'stator-map-'))
    const statorPath = join(dir, 'boom.stator')
    const out = compile(src, { id: 'boom.stator', sourceMap: { source: statorPath } })
    const { code } = await transform(out.serverCode, {
      loader: 'ts',
      format: 'esm',
      sourcemap: 'inline',
      sourcefile: statorPath,
    })
    // Resolve the template primitives import against this package.
    const file = join(dir, 'boom.mjs')
    writeFileSync(
      file,
      code.replace(
        /["']@statorjs\/stator\/template["']/,
        JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/template/index.ts')).href),
      ),
    )
    const mod = (await import(pathToFileURL(file).href)) as { default: () => unknown }
    const err = (() => {
      try {
        mod.default()
      } catch (e) {
        return e as Error
      }
    })()
    assert.ok(err)
    assert.ok(err.stack)
    assert.match(err.stack, /boom\.stator:3:/)
    assert.match(err.stack, /boom\.stator:6:/)
  })
})

/** The location a compile error reports. */
function errorAt(source: string, kind: 'route' | 'component' = 'component') {
  try {
    compile(source, { id: 'x.stator', kind })
  } catch (e) {
    assert.ok(e instanceof CompileError)
    assert.ok(e.loc)
    return { line: e.loc.line, column: e.loc.column }
  }
  assert.fail('expected a CompileError')
}

describe('diagnostic positions the source-map offsets fixed', () => {
  it('a template error after a <script is:inline> points at its own line', () => {
    const src = `<div>\n  <script is:inline>window.a = { long: 'payload' }</script>\n  <p ref:x={1}>hi</p>\n</div>\n`
    assert.deepStrictEqual(errorAt(src), { line: 3, column: 6 })
  })

  it('a frontmatter error in a fence that opens with blank lines points at its own line', () => {
    const src = `---\n\n\nconst r = Stator.request\n---\n<p>hi</p>\n`
    assert.deepStrictEqual(errorAt(src), { line: 4, column: 11 })
  })
})
