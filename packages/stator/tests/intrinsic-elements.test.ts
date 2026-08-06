import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { toVirtualCode } from '../src/compiler/virtual-code.ts'

/**
 * Per-element `JSX.IntrinsicElements`: a typo on a PLAIN element (`<button typ=>`)
 * is a real error, while directives, the `data-*` family, and custom-element
 * islands stay open (the `[tag: string]: any` fallback). Reactivity (attribute
 * values as live `read(...)` bindings) is covered by every example typechecking
 * clean.
 */

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, '.tmp-intrinsics')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const GOOD_BUTTON = `---
---
<button type="submit" disabled on:click={() => {}} aria-label="go" data-id="1">ok</button>
`

const BAD_BUTTON = `---
---
<button typ="submit">typo</button>
`

const DIV_DIRECTIVES = `---
---
<div class:list={{ a: true }} style:list={{ '--c': 'red' }} class="x">ok</div>
`

// A client-island custom element with island-specific attributes — must stay
// permissive (falls to the [tag: string]: any escape valve).
const ISLAND = `---
---
<live-sky scene="clear-day" initial-color="blue" custom-attr="y" data-id="1">sky</live-sky>
`

function emitAll(): Record<string, string> {
  mkdirSync(dir, { recursive: true })
  const files: Record<string, string> = {}
  for (const [name, src] of [
    ['good-button', GOOD_BUTTON],
    ['bad-button', BAD_BUTTON],
    ['div-directives', DIV_DIRECTIVES],
    ['island', ISLAND],
  ] as const) {
    const file = join(dir, `${name}.tsx`)
    writeFileSync(file, toVirtualCode(src).tsx.code.replace(/\.stator'/g, "'"))
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

describe('per-element JSX.IntrinsicElements', () => {
  const diags = diagnosticsFor(emitAll())

  it('a plain <button> accepts native attrs + directives + data-* + aria', () => {
    expect(diags.get('good-button')).toEqual([])
  })

  it('a typo on a plain <button> is now a real error', () => {
    const bad = diags.get('bad-button')!
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.join('\n')).toMatch(/typ/)
  })

  it('class:list / style:list directives are accepted', () => {
    expect(diags.get('div-directives')).toEqual([])
  })

  it('a custom-element island stays permissive (island attributes pass)', () => {
    expect(diags.get('island')).toEqual([])
  })
})
