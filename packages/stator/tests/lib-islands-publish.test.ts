import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileLibrary } from '../src/build/compile-library.ts'
import { stubMachineImports } from '../src/build/lib-client.ts'
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

const MACHINE = `import { defineMachine } from '@statorjs/stator/machine'

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
    assert.ok(client.includes('const Counter = /* @stator machine */ { name: "CounterMachine" };'))
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
    assert.ok(client.includes('const Counter = /* @stator machine */'))
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

  it('stubs a default import beside type-only named ones, keeping the types', async () => {
    const dir = scaffold("  import Counter, { type Never } from '../machines/counter.ts'\n")
    const result = await compileLibrary({ root, dir })
    const client = readFileSync(join(dir, 'stepper.stator.client.ts'), 'utf8')
    assert.ok(
      client.includes(
        'const Counter = /* @stator machine */ { name: "CounterMachine" }; ' +
          'import type { Never } from "../machines/counter.ts";',
      ),
      client,
    )
    assert.deepStrictEqual(result.machines, ['CounterMachine'])
  })

  const RUNS = `${STUBBED}  import Local from './local.ts'\n\n  const start = () => use(Local)\n  void start\n`
  const LOCAL = MACHINE.replace('CounterMachine', 'Local')

  it('leaves a machine the island passes to use() in the entry', async () => {
    const dir = scaffold(RUNS, { 'src/local.ts': LOCAL })
    const result = await compileLibrary({ root, dir })
    const client = readFileSync(join(dir, 'stepper.stator.client.ts'), 'utf8')
    assert.match(client, /import Local from '\.\/local(\.ts|\.js)?'/)
    assert.ok(client.includes('const Counter = /* @stator machine */ { name: "CounterMachine" };'))
    assert.deepStrictEqual(result.machines, ['CounterMachine'])
  })

  it('leaves a module in the entry when the island reads a value from it', async () => {
    const dir = scaffold(
      "  import Counter, { LIMIT } from '../machines/counter.ts'\n  void LIMIT\n",
      { 'machines/counter.ts': `${MACHINE}\nexport const LIMIT = 3\n` },
    )
    const result = await compileLibrary({ root, dir })
    const client = readFileSync(join(dir, 'stepper.stator.client.ts'), 'utf8')
    assert.ok(client.includes('../machines/counter'), client)
    assert.ok(!client.includes('@stator machine'))
    assert.deepStrictEqual(result.machines, [])
  })

  it('refuses a machine the island runs whose module imports the server entry', async () => {
    const dir = scaffold(RUNS, {
      'src/local.ts': `import { sessionStore } from '@statorjs/stator/server'\n${LOCAL}\nvoid sessionStore\n`,
    })
    await assert.rejects(compileLibrary({ root, dir }), (err: Error) => {
      assert.match(err.message, /stepper\.stator\.client\.ts would ship server code to the browser/)
      assert.match(err.message, /src\/local\.ts imports "@statorjs\/stator\/server"/)
      return true
    })
  })

  it('refuses a server-pinned machine the island runs', async () => {
    const dir = scaffold(RUNS, {
      'src/local.ts': LOCAL.replace(
        'export default',
        "import Counter from '../machines/counter.ts'\n\nexport default",
      ).replace("lifecycle: 'session',", "lifecycle: 'session',\n  reads: [Counter],"),
    })
    await assert.rejects(
      compileLibrary({ root, dir }),
      /passes "Local" from .*src\/local\.ts to use\(\).*server-pinned: it reads machine "CounterMachine"/,
    )
  })

  it('refuses a machine import the island uses in a way that says neither', async () => {
    const dir = scaffold(`${STUBBED}  const all = [Counter]\n  void all\n`)
    await assert.rejects(
      compileLibrary({ root, dir }),
      /stepper\.stator:\d+ uses the machine import "Counter" from "\.\.\/machines\/counter(\.ts|\.js)?" in a way the build cannot place/,
    )
  })
})

describe('the machine stub rewrite', () => {
  it('stubs a machine defined through a namespace import of @statorjs/stator/server', async () => {
    const dir = scaffold(STUBBED, {
      'machines/counter.ts': MACHINE.replace(
        "import { defineMachine } from '@statorjs/stator/machine'",
        "import * as S from '@statorjs/stator/machine'",
      ).replace('export default defineMachine(', 'export default S.defineMachine('),
    })
    const result = await compileLibrary({ root, dir })
    assert.deepStrictEqual(result.machines, ['CounterMachine'])
    const client = readFileSync(join(dir, 'stepper.stator.client.ts'), 'utf8')
    assert.ok(client.includes('const Counter = /* @stator machine */ { name: "CounterMachine" };'))
  })

  it('rewrites only real imports, line for line, leaving comments and strings alone', async () => {
    scaffold(STUBBED)
    const file = join(root, 'src/entry.ts')
    const before = [
      "import { defineElement } from '@statorjs/stator/client'",
      '// import Ghost from "../machines/counter.ts"',
      'const doc = "import Ghost2 from \'../machines/counter.ts\'"',
      'import Counter',
      "  from '../machines/counter.ts'",
      'export const used = [dispatch(Counter, { type: doc })]',
      '//# sourceMappingURL=data:application/json;base64,e30=',
    ].join('\n')
    writeFileSync(file, before)
    assert.deepStrictEqual(await stubMachineImports(file), ['CounterMachine'])
    const after = readFileSync(file, 'utf8')
    const [b, a] = [before.split('\n'), after.split('\n')]
    assert.equal(a.length, b.length)
    assert.deepStrictEqual(
      a.map((line, i) => (line === b[i] ? null : i)).filter((i) => i !== null),
      [3, 4],
    )
    assert.equal(a[3], 'const Counter = /* @stator machine */ { name: "CounterMachine" };')
    assert.equal(a[4], '')
    assert.ok(after.includes('// import Ghost from "../machines/counter.ts"'))
    assert.ok(after.includes("import Ghost2 from '../machines/counter.ts'"))
  })
})

describe('the contract pragma', () => {
  it('reads as absent from a module compiled before stamps existed', () => {
    assert.equal(readContract("import { html } from '@statorjs/stator/template'\n"), undefined)
  })
})
