import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { compile, generateDts, toVirtualCode } from '../src/compiler/index.ts'

/**
 * Compiled output typechecks on its own, under a strict consumer config. A
 * library ships compiled `.stator.ts` files and a consuming app's `tsc`
 * checks them like any other TypeScript it imports, so route `reads` handles
 * must carry their machine types and a component without props must accept
 * the empty props object its callers pass, and an island's shell must take
 * the props its declaration types. (`noUnusedLocals` is not on:
 * compiled modules import every template primitive, used or not.)
 *
 * Files land under tests/ so `@statorjs/stator/*` imports resolve through the
 * package's self-link.
 */

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, '.tmp-compiled-typecheck')
after(() => rmSync(dir, { recursive: true, force: true }))

const MACHINE = `import { defineMachine } from '@statorjs/stator/machine'

export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  events: {} as { type: 'ADD'; productId: string },
  context: { items: [] as string[] },
  initial: 'idle',
  states: { idle: { on: { ADD: (ctx, ev) => { ctx.items.push(ev.productId) } } } },
  selectors: { itemCount: (ctx) => ctx.items.length },
})
`

const BADGE = `<span class="badge">new</span>
<style>.badge { color: red; }</style>
`

const SUMMARY = `---
import type { InstanceOf } from '@statorjs/stator/template'
import type CartMachine from '../machines/cart.ts'

const { cart } = Stator.props<{ cart: InstanceOf<typeof CartMachine> }>()
---
<p>{read(cart, (c) => c.itemCount)} items</p>
`

const ROUTE = `---
import CartMachine from '../machines/cart.ts'
import Badge from '../templates/badge.stator'
import Summary from '../templates/summary.stator'

const [cart] = Stator.reads([CartMachine])
---
<main><Badge /><Summary cart={cart} /><p>{read(cart, (c) => c.itemCount)}</p></main>
`

const RICH_EDITOR = `<rich-editor><p>editor</p></rich-editor>

<script>
  export class RichEditor extends StatorElement {
    static attrs = { target: String, kind: String }
  }
</script>
`

const BARE_ISLAND = `<bare-island><p>bare</p></bare-island>

<script>
  export class BareIsland extends StatorElement {}
</script>
`

const ISLAND_USER = `<div>
  <RichEditor target="content" kind="post" />
  <RichEditor target="content" extra={{ any: 'thing' }} />
  <BareIsland anything={1} />
</div>
`

const BAD_ISLAND_USER = `<div><RichEditor target={42} /></div>
`

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}

/** Compile each entry to `<path>.ts` under `dir`, imports pointed at the compiled siblings. */
function compileAll(entries: ReadonlyArray<readonly [string, string, 'route' | 'component']>) {
  return entries.map(([path, src, kind]) => {
    const out = compile(src, { id: path, kind }).serverCode.replace(
      /(['"])(\.{1,2}\/[^'"]+\.stator)\1/g,
      '$1$2.ts$1',
    )
    write(`${path}.ts`, out)
    return join(dir, `${path}.ts`)
  })
}

/** Diagnostics for `files` under a strict consumer config, as `file:line: message`. */
function check(files: string[], options: ts.CompilerOptions = {}): string[] {
  const program = ts.createProgram(files, {
    strict: true,
    noUnusedParameters: true,
    noEmit: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    types: [],
    ...options,
  })
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName.startsWith(dir))
    .map((d) => {
      const at = d.file!.getLineAndCharacterOfPosition(d.start ?? 0)
      return `${d.file!.fileName.slice(dir.length + 1)}:${at.line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`
    })
}

/** The type text of a module's default-export function's first parameter. */
function firstParamType(code: string): string {
  const sf = ts.createSourceFile('m.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let found: string | undefined
  const visit = (n: ts.Node): void => {
    if (found !== undefined) return
    if (
      (ts.isFunctionDeclaration(n) || ts.isFunctionTypeNode(n)) &&
      n.parameters[0]?.type &&
      (ts.isFunctionTypeNode(n) ||
        n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
    ) {
      found = n.parameters[0].type.getText(sf)
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  assert.ok(found !== undefined, `no typed default-export parameter in:\n${code}`)
  return found
}

describe('compiled output typechecks', () => {
  it('a route with reads and a component without props, under strict', () => {
    rmSync(dir, { recursive: true, force: true })
    write('machines/cart.ts', MACHINE)
    const files = compileAll([
      ['templates/badge.stator', BADGE, 'component'],
      ['templates/summary.stator', SUMMARY, 'component'],
      ['routes/index.stator', ROUTE, 'route'],
    ])
    assert.deepStrictEqual(check(files), [])
  })

  it('an island shell takes its declared attrs and the open tail, under strict', () => {
    rmSync(dir, { recursive: true, force: true })
    const user = `---\nimport RichEditor from './rich-editor.stator'\nimport BareIsland from './bare-island.stator'\n---\n${ISLAND_USER}`
    const files = compileAll([
      ['templates/rich-editor.stator', RICH_EDITOR, 'component'],
      ['templates/bare-island.stator', BARE_ISLAND, 'component'],
      ['templates/island-user.stator', user, 'component'],
    ])
    assert.deepStrictEqual(check(files), [])

    // The JSX use site `stator check` sees, resolving to the compiled shells.
    write('templates/island-user.check.tsx', toVirtualCode(user).tsx.code)
    const jsx = check([join(dir, 'templates/island-user.check.tsx')], {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    })
    assert.deepStrictEqual(jsx, [])
  })

  it('an island shell rejects a wrong attr type', () => {
    rmSync(dir, { recursive: true, force: true })
    const files = compileAll([
      ['templates/rich-editor.stator', RICH_EDITOR, 'component'],
      [
        'templates/bad-user.stator',
        `---\nimport RichEditor from './rich-editor.stator'\n---\n${BAD_ISLAND_USER}`,
        'component',
      ],
    ])
    const diagnostics = check(files)
    assert.equal(diagnostics.length, 1, diagnostics.join('\n'))
    assert.match(
      diagnostics[0]!,
      /^templates\/bad-user\.stator\.ts:\d+: Type 'number' is not assignable/,
    )
  })

  it("a shell's parameter type is its declaration's props type", () => {
    for (const src of [RICH_EDITOR, BARE_ISLAND, BADGE, SUMMARY, ISLAND_USER]) {
      const shell = compile(src, { id: 'x.stator' }).serverCode
      assert.equal(firstParamType(shell), firstParamType(generateDts(src)!))
    }
  })
})
