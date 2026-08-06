import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { toVirtualCode } from '../src/compiler/virtual-code.ts'

/**
 * The `HTMLAttributes<'button'>` component-extension pattern (Astro/Svelte-style):
 * a component can extend a native element's attributes + add its own props, and
 * usages are validated against that. This needs NO compiler change — a
 * component's attributes check against its OWN props type (the default-export
 * param in the virtual code), so it's orthogonal to `IntrinsicElements`.
 *
 * Runs real tsc over the emitted virtual TSX, like the editor wires it. Files
 * land under tests/ so `@statorjs/stator/template` resolves via the self-link.
 */

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, '.tmp-html-attrs')

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

// A <Button> whose props ARE the native button attributes plus a variant.
const BUTTON = `---
import type { HTMLAttributes } from '@statorjs/stator/template'

const { variant, type = 'button' } =
  Stator.props<HTMLAttributes<'button'> & { variant: 'primary' | 'danger' }>()
---
<button type={type} class={\`btn btn-\${variant}\`}><children /></button>
`

// Valid: a native button attr (type), a directive (on:click), a boolean attr
// (disabled), and the component's own required prop (variant).
const USE_GOOD = `---
import Button from './button.stator'
---
<Button type="submit" variant="danger" disabled on:click={() => {}}>Go</Button>
`

// A typo'd attribute — not a real button attribute, not a directive.
const USE_BAD_ATTR = `---
import Button from './button.stator'
---
<Button typ="submit" variant="danger">Go</Button>
`

// A value outside the component's own union.
const USE_BAD_VARIANT = `---
import Button from './button.stator'
---
<Button variant="nope">Go</Button>
`

// A native button attr with the wrong value type.
const USE_BAD_NATIVE = `---
import Button from './button.stator'
---
<Button type="lol" variant="primary">Go</Button>
`

function emitAll(): Record<string, string> {
  mkdirSync(dir, { recursive: true })
  const files: Record<string, string> = {}
  for (const [name, src] of [
    ['button', BUTTON],
    ['use-good', USE_GOOD],
    ['use-bad-attr', USE_BAD_ATTR],
    ['use-bad-variant', USE_BAD_VARIANT],
    ['use-bad-native', USE_BAD_NATIVE],
  ] as const) {
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

describe('HTMLAttributes<Tag> — the <Button> component pattern', () => {
  const diags = diagnosticsFor(emitAll())

  it('the Button component itself typechecks', () => {
    expect(diags.get('button')).toEqual([])
  })

  it('accepts native attrs + a directive + its own prop', () => {
    expect(diags.get('use-good')).toEqual([])
  })

  it('rejects a typo attribute that is neither native nor a directive', () => {
    const bad = diags.get('use-bad-attr')!
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.join('\n')).toMatch(/typ/)
  })

  it("rejects a value outside the component's own union", () => {
    const bad = diags.get('use-bad-variant')!
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.join('\n')).toMatch(/nope|not assignable/)
  })

  it('rejects a native attr with the wrong value type', () => {
    const bad = diags.get('use-bad-native')!
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.join('\n')).toMatch(/lol|not assignable/)
  })
})
