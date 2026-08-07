import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { toVirtualCode } from '../src/compiler/virtual-code.ts'

/**
 * Typecheck-level regression net for the language-server emit: run REAL tsc
 * over emitted virtual TSX, wired together like the editor wires them. This
 * is what catches ambient-typing regressions that string assertions can't —
 * e.g. `Stator.reads` bindings must be assignable to component props typed
 * with the template `InstanceOf` (they carry send/state/snapshot).
 *
 * Files land under tests/ so `@statorjs/stator/*` imports resolve through the
 * package's self-link.
 */

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, '.tmp-vtsx-typecheck')

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CART_MACHINE = `
import { defineMachine } from '@statorjs/stator/server'

type Events = { type: 'ADD'; productId: string }

export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { items: [] as string[] },
  initial: 'idle',
  states: { idle: { on: { ADD: (ctx, ev) => { ctx.items.push(ev.productId) } } } },
  selectors: {
    itemCount: (ctx) => ctx.items.length,
  },
})
`

const LAYOUT = `---
import type { InstanceOf } from '@statorjs/stator/template'
import type CartMachine from './cart-machine.ts'

const { cart } = Stator.props<{ cart: InstanceOf<typeof CartMachine> }>()
---
<header>{read(cart, (c) => c.itemCount)}</header>
<main><children /></main>
`

const ROUTE_GOOD = `---
import CartMachine from './cart-machine.ts'
import CustomerLayout from './customer-layout.stator'

const [cart] = Stator.reads([CartMachine])
---
<CustomerLayout cart={cart}>
  <h1>hi</h1>
</CustomerLayout>
`

const ROUTE_BAD = `---
import CustomerLayout from './customer-layout.stator'
---
<CustomerLayout cart={{ notACart: true }}>
  <h1>hi</h1>
</CustomerLayout>
`

// Frontmatter is synchronous — its body compiles into a non-async render
// function, so a top-level `await` must be a TS error in the editor too (the
// emitter once placed the body at module scope, where top-level await is legal,
// silently diverging from runtime).
const COMPONENT_AWAIT = `---
const data = await Promise.resolve(1)
---
<p>{String(data)}</p>
`

// The HTMLAttributes<Tag> + attribute-spread pattern end to end: a component
// extends a native element's attributes and forwards the rest onto it via
// {...rest}. The typecheck path keeps the spread as native JSX, so tsc validates
// `rest` (HTMLAttributes<'button'>) against the <button> intrinsic — clean.
const BUTTON = `---
import type { HTMLAttributes } from '@statorjs/stator/template'

const { variant, ...rest } = Stator.props<HTMLAttributes<'button'> & { variant?: 'primary' | 'ghost' }>()
---
<button class={variant} {...rest}><children /></button>
`

// A spread whose type CONFLICTS with a known attribute (disabled: string, but a
// button's disabled is boolean) must still be a real error at the element —
// proving the spread is typechecked, not waved through.
const BUTTON_BAD = `---
const wrong = { disabled: 'yes' }
---
<button {...wrong}>x</button>
`

// A forwarding component: it reads a parent-forwarded on:click via
// Stator.forwarded and re-attaches it to a chosen inner element. Both the
// accessor (ambient-typed) and the directive placement must typecheck clean.
const FORWARD_BUTTON = `---
import type { HTMLAttributes } from '@statorjs/stator/template'
const { variant, ...rest } = Stator.props<HTMLAttributes<'button'> & { variant?: 'primary' }>()
const onClick = Stator.forwarded('on:click')
---
<button class={variant} on:click={onClick} {...rest}><children /></button>
`

function emitAll(): Record<string, string> {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cart-machine.ts'), CART_MACHINE)
  const files: Record<string, string> = {}
  for (const [name, src] of [
    ['customer-layout', LAYOUT],
    ['route-good', ROUTE_GOOD],
    ['route-bad', ROUTE_BAD],
    ['component-await', COMPONENT_AWAIT],
    ['button', BUTTON],
    ['button-bad', BUTTON_BAD],
    ['forward-button', FORWARD_BUTTON],
  ] as const) {
    // The editor resolves `.stator` imports through the language plugin; here
    // tsc plays that role by resolving the emitted sibling `.tsx`.
    const code = toVirtualCode(src).tsx.code.replace(/\.stator'/g, "'")
    const file = join(dir, `${name}.tsx`)
    writeFileSync(file, code)
    files[name] = file
  }
  return files
}

function diagnosticsFor(files: Record<string, string>): Map<string, string[]> {
  const program = ts.createProgram(Object.values(files), {
    strict: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  })
  const byFile = new Map<string, string[]>()
  for (const [name, file] of Object.entries(files)) {
    const source = program.getSourceFile(file)
    const diags = source ? program.getSemanticDiagnostics(source) : []
    byFile.set(
      name,
      diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    )
  }
  return byFile
}

describe('virtual code under real tsc (the editor contract)', () => {
  const diags = diagnosticsFor(emitAll())

  it('a Stator.reads binding is assignable to InstanceOf props — no false positives', () => {
    // Regression: the ambient once typed reads with the engine (selectors-only)
    // InstanceOf, making every binding "missing send, state, snapshot".
    expect(diags.get('route-good')).toEqual([])
    expect(diags.get('customer-layout')).toEqual([])
  })

  it('a wrong prop shape is a real error at the usage site', () => {
    const bad = diags.get('route-bad')!
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.join('\n')).toMatch(/notACart|not assignable/)
  })

  it('a component forwards {...rest} onto a native element and typechecks clean', () => {
    expect(diags.get('button')).toEqual([])
  })

  it('a spread whose type conflicts with a known attribute is a real error', () => {
    const bad = diags.get('button-bad')!
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.join('\n')).toMatch(/disabled|not assignable/)
  })

  it('a forwarding component (Stator.forwarded + on:click on an inner element) typechecks clean', () => {
    expect(diags.get('forward-button')).toEqual([])
  })

  it('a top-level await in frontmatter is a TS error (sync-frontmatter contract)', () => {
    // The body compiles into a non-async render function, so `await` there is
    // TS1308 — surfaced in-editor, matching the runtime. A regression that moved
    // the body back to module scope would make this pass silently.
    const awaited = diags.get('component-await')!
    expect(awaited.join('\n')).toMatch(
      /'await' expressions are only allowed within async functions/,
    )
  })
})
