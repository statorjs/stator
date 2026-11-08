import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transform } from 'esbuild'
import { bundleIslands } from '../src/build/islands.ts'
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
function sourceOf(
  code: string,
  map: SourceMapV3,
  needle: string,
  from = 0,
): { line: number; col: number } {
  const at = code.indexOf(needle, from)
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
function inSource(needle: string, src = ROUTE): { line: number; col: number } {
  const at = src.indexOf(needle)
  assert.notEqual(at, -1, needle)
  return {
    line: src.slice(0, at).split('\n').length - 1,
    col: at - (src.lastIndexOf('\n', at - 1) + 1),
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

  it("an error in an island's markup points at its own line (it had no location)", () => {
    const src = `<tick-counter>\n  <button on:click>tick</button>\n</tick-counter>\n\n<script>\n  export class TickCounter extends StatorElement {}\n</script>\n`
    assert.deepStrictEqual(errorAt(src), { line: 2, column: 11 })
  })

  it('a frontmatter error in a fence that opens with blank lines points at its own line', () => {
    const src = `---\n\n\nconst r = Stator.request\n---\n<p>hi</p>\n`
    assert.deepStrictEqual(errorAt(src), { line: 4, column: 11 })
  })
})

const ISLAND = `---
import { label } from './label.ts'

const title = label('ticks')
---
<tick-counter>
  <h2>{title.toUpperCase()}</h2>
  <button on:click={inc}>tick</button>
  <span>{read(n, (x) => x.count)}</span>
</tick-counter>

<script>
  import { machine, StatorElement, use } from '@statorjs/stator/client'

  const N = machine({ count: 0 }, { on: { INC: (s) => { s.count++ } } })
  export class TickCounter extends StatorElement {
    n = use(N)
    inc() {
      this.n.send('INC')
    }
  }
</script>
`

describe('island source maps', () => {
  const plain = compile(ISLAND, { id: 'templates/tick-counter.stator' })
  const mapped = compile(ISLAND, {
    id: 'templates/tick-counter.stator',
    sourceMap: { source: '/app/templates/tick-counter.stator' },
  })
  const strip = (code: string) => code.split(/(?=\/\/# sourceMappingURL=)/)[0]

  it('changes neither half but for the trailing map comments', () => {
    assert.equal(mapped.isClient, true)
    assert.equal(strip(mapped.serverCode), plain.serverCode)
    assert.equal(strip(mapped.clientCode), plain.clientCode)
    assert.match(mapped.clientCode, /\/\/# sourceMappingURL=data:application\/json;base64,/)
  })

  it('maps the server fence and the shell template', () => {
    assert.ok(mapped.map)
    for (const needle of [
      "import { label } from './label.ts'",
      "label('ticks')",
      'title.toUpperCase()',
    ]) {
      assert.deepStrictEqual(
        sourceOf(mapped.serverCode, mapped.map, needle),
        inSource(needle, ISLAND),
        needle,
      )
    }
  })

  it('maps the script line for line, past the stripped client import', () => {
    assert.ok(mapped.clientMap)
    for (const needle of ['const N = machine(', 'n = use(N)', "this.n.send('INC')"]) {
      assert.deepStrictEqual(
        sourceOf(mapped.clientCode, mapped.clientMap, needle),
        inSource(needle, ISLAND),
        needle,
      )
    }
  })

  it('maps each wiring line to the directive it wires', () => {
    assert.ok(mapped.clientMap)
    const setup = mapped.clientCode.indexOf('setup()')
    assert.equal(
      sourceOf(mapped.clientCode, mapped.clientMap, 'addEventListener', setup).line,
      inSource('on:click', ISLAND).line,
    )
    assert.equal(
      sourceOf(mapped.clientCode, mapped.clientMap, 'bindSlot', setup).line,
      inSource('read(n,', ISLAND).line,
    )
  })
})

describe('island maps through the dev bundler', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const dir = resolve(here, 'fixtures/.tmp-island-map')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it("the bundle's map names the .stator and lands the script's lines on it", async () => {
    mkdirSync(join(dir, 'templates'), { recursive: true })
    mkdirSync(join(dir, 'machines'), { recursive: true })
    const file = join(dir, 'templates', 'tick-counter.stator')
    const src = ISLAND.replace(/^---[\s\S]*?---\n/, '')
    writeFileSync(file, src)
    const bundle = await bundleIslands({
      root: dir,
      machinesDir: join(dir, 'machines'),
      entries: [{ rel: 'templates/tick-counter.stator', file }],
      sourcemap: true,
    })
    const url = bundle.islandUrls['templates/tick-counter.stator']
    assert.ok(url)
    const chunk = bundle.assets.find((a) => url.endsWith(a.fileName))
    assert.ok(chunk)
    const code = String(chunk.source)
    const b64 = /sourceMappingURL=data:application\/json;base64,(\S+)\s*$/.exec(code)?.[1]
    assert.ok(b64)
    const map = JSON.parse(Buffer.from(b64, 'base64').toString()) as SourceMapV3
    const index = map.sources.findIndex((s) => s.endsWith('templates/tick-counter.stator'))
    assert.notEqual(index, -1, map.sources.join(', '))
    // esbuild rewrites the send call's text; find it by its stable part.
    const line = sourceOf(code.replace(/\/\/# sourceMappingURL=.*$/s, ''), map, '.send("INC")').line
    assert.equal(line, inSource("this.n.send('INC')", src).line)
  })
})
