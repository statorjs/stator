import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { compile } from '../src/compiler/index.ts'

/**
 * Compiled output typechecks on its own, under a strict consumer config. A
 * library ships compiled `.stator.ts` files and a consuming app's `tsc`
 * checks them like any other TypeScript it imports, so route `reads` handles
 * must carry their machine types and a component without props must accept
 * the empty props object its callers pass. (`noUnusedLocals` is not on:
 * compiled modules import every template primitive, used or not.)
 *
 * Files land under tests/ so `@statorjs/stator/*` imports resolve through the
 * package's self-link.
 */

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, '.tmp-compiled-typecheck')
after(() => rmSync(dir, { recursive: true, force: true }))

const MACHINE = `import { defineMachine } from '@statorjs/stator/server'

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

describe('compiled output typechecks', () => {
  it('a route with reads and a component without props, under strict', () => {
    rmSync(dir, { recursive: true, force: true })
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    write('machines/cart.ts', MACHINE)
    const files: string[] = []
    for (const [path, src, kind] of [
      ['templates/badge.stator', BADGE, 'component'],
      ['templates/summary.stator', SUMMARY, 'component'],
      ['routes/index.stator', ROUTE, 'route'],
    ] as const) {
      const out = compile(src, { id: path, kind }).serverCode.replace(
        /(['"])(\.{1,2}\/[^'"]+\.stator)\1/g,
        '$1$2.ts$1',
      )
      write(`${path}.ts`, out)
      files.push(join(dir, `${path}.ts`))
    }
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
    })
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName.startsWith(dir))
      .map((d) => {
        const at = d.file!.getLineAndCharacterOfPosition(d.start ?? 0)
        return `${d.file!.fileName.slice(dir.length + 1)}:${at.line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`
      })
    assert.deepStrictEqual(diagnostics, [])
  })
})
