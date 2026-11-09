import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileLibrary } from '../src/build/compile-library.ts'
import { COMPILED_CONTRACT, readContract } from '../src/compiler/index.ts'
import { statorVersion } from '../src/version.ts'

/**
 * `stator build:lib` for a library that ships an island: the contract stamp,
 * the line-preserving machine stub, the browser-safety pass, and the inline map
 * pointing at the shipped `.stator`. The fixture lives under the package so
 * `@statorjs/stator` resolves through its self-link.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/.tmp-lib-islands')
after(() => rmSync(root, { recursive: true, force: true }))

const MACHINE = `import { defineMachine } from '@statorjs/stator/server'

export default defineMachine({
  name: 'CounterMachine',
  lifecycle: 'session',
  events: {} as { type: 'INCREMENT' },
  context: { count: 0 },
  initial: 'idle',
  states: { idle: { on: { INCREMENT: (ctx) => { ctx.count += 1 } } } },
  selectors: {},
})
`

// The machine import spans two lines, so the stub has to keep both.
const ISLAND = (script: string) => `<count-stepper>
  <button type="button" on:click={bump}>+1</button>
</count-stepper>

<script>
${script}
  export class CountStepper extends StatorElement {
    bump() {
      void dispatch(Counter, { type: 'INCREMENT' })
    }
  }
</script>
`

function scaffold(script: string, files: Record<string, string> = {}): string {
  rmSync(root, { recursive: true, force: true })
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: '@acme/blocks', type: 'module' }),
    'machines/counter.ts': MACHINE,
    'src/stepper.stator': ISLAND(script),
    ...files,
  }
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return join(root, 'src')
}

const STUBBED = "  import Counter\n    from '../machines/counter.ts'\n"

/** Decode a V3 `mappings` string into [genLine, genCol, srcLine, srcCol]. */
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
      genCol += fields[0] ?? 0
      srcLine += fields[2] ?? 0
      srcCol += fields[3] ?? 0
      out.push([genLine, genCol, srcLine, srcCol])
    }
  })
  return out
}

describe('build:lib for a library island', () => {
  let src = ''
  beforeEach(() => {
    src = scaffold(STUBBED)
  })

  it('stamps the compiled-shape contract on line 1 of both compiled files', async () => {
    await compileLibrary({ root, dir: src })
    for (const file of ['stepper.stator.ts', 'stepper.stator.client.ts']) {
      const stamp = readContract(readFileSync(join(src, file), 'utf8'))
      assert.ok(stamp, file)
      assert.equal(stamp.contract, COMPILED_CONTRACT)
      assert.equal(stamp.compiler, statorVersion())
    }
  })

  it('replaces the machine import with its { name }, and reports the machine', async () => {
    const result = await compileLibrary({ root, dir: src })
    const client = readFileSync(join(src, 'stepper.stator.client.ts'), 'utf8')
    assert.ok(client.includes('const Counter = { name: "CounterMachine" };'))
    assert.ok(!client.includes('../machines/counter.ts'))
    assert.deepStrictEqual(result.machines, ['CounterMachine'])
  })

  it("keeps the client entry's map valid through the stub, pointing at the shipped .stator", async () => {
    await compileLibrary({ root, dir: src })
    const client = readFileSync(join(src, 'stepper.stator.client.ts'), 'utf8')
    const b64 = /sourceMappingURL=data:application\/json;base64,(\S+)\s*$/.exec(client)?.[1]
    assert.ok(b64)
    const map = JSON.parse(Buffer.from(b64, 'base64').toString()) as {
      sources: string[]
      mappings: string
    }
    assert.deepStrictEqual(map.sources, ['stepper.stator'])
    assert.ok(existsSync(join(src, 'stepper.stator')), 'the source ships beside it')
    const lines = client.split('\n')
    const genLine = lines.findIndex((l) => l.includes('void dispatch(Counter'))
    const seg = decode(map.mappings).filter(([l]) => l === genLine)[0]
    assert.ok(seg)
    const srcLine = readFileSync(join(src, 'stepper.stator'), 'utf8')
      .split('\n')
      .findIndex((l) => l.includes('void dispatch(Counter'))
    assert.equal(seg[2], srcLine)
  })

  it('refuses a client entry that reaches a Node built-in, naming the importer', async () => {
    const dir = scaffold(
      `${STUBBED}  import { stamp } from './fs-helper.ts'\n  console.log(stamp)\n`,
      {
        'src/fs-helper.ts':
          "import { readFileSync } from 'node:fs'\nexport const stamp = readFileSync\n",
      },
    )
    await assert.rejects(compileLibrary({ root, dir }), (err: Error) => {
      assert.match(err.message, /stepper\.stator\.client\.ts would ship server code to the browser/)
      assert.match(err.message, /src\/fs-helper\.ts imports "node:fs"/)
      return true
    })
  })

  it('refuses a machine imported any way but by default, since only that can be stubbed', async () => {
    const dir = scaffold("  import Counter, { type Never } from '../machines/counter.ts'\n")
    await assert.rejects(compileLibrary({ root, dir }), (err: Error) => {
      assert.match(err.message, /machines\/counter\.ts imports "@statorjs\/stator\/server"/)
      return true
    })
  })
})

describe('the contract pragma', () => {
  it('reads as absent from a module compiled before stamps existed', () => {
    assert.equal(readContract("import { html } from '@statorjs/stator/template'\n"), undefined)
  })
})
