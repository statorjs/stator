import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { generateDts } from '../compiler/dts.ts'
import { toVirtualCode } from '../compiler/virtual-code.ts'

/**
 * Type sync: generate a `<name>.stator.d.ts` for each component so editors and
 * `tsc` type `import X from './x.stator'` against the component's real props
 * (the `.d.ts` beats the `*.stator` ambient wildcard).
 *
 * The generated files live in a hidden, framework-managed `.stator/types/`
 * directory that MIRRORS the source tree — never next to source. TS finds them
 * via `rootDirs: ['.', '.stator/types']` in the app's tsconfig, which merges the
 * two trees into one virtual root (the Astro `.astro/` / SvelteKit `.svelte-kit/`
 * convention). `.stator/` is gitignored.
 *
 * Route pages (`routes/*.stator`) are skipped — they export `GET`, not a render
 * function.
 *
 * Sync ALSO emits each template's virtual TSX (the same code the language
 * server typechecks in-editor) under `.stator/check/`, so plain `tsc --noEmit`
 * covers TEMPLATE INTERNALS in CI — frontmatter/prop mismatches otherwise
 * surface only as runtime ReferenceErrors. Opt-in per app: add
 * ".stator/check" to `rootDirs` and its .tsx files to `include` (see the
 * example tsconfigs); apps that don't are unaffected (the files sit ignored).
 */
export interface SyncResult {
  /** Number of `.stator.d.ts` files written. */
  written: number
  /** Number of `.check.tsx` virtual files written. */
  checks: number
  /** The generated-types directory. */
  outDir: string
}

const TYPES_DIR = join('.stator', 'types')
const CHECK_DIR = join('.stator', 'check')

export async function syncTypes(root: string): Promise<SyncResult> {
  const outDir = join(root, TYPES_DIR)
  const checkDir = join(root, CHECK_DIR)
  await rm(outDir, { recursive: true, force: true })
  await rm(checkDir, { recursive: true, force: true })

  const files = await walk(root)
  let written = 0
  let checks = 0
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const rel = relative(root, file)

    const kind = file.split(sep).includes('routes') ? 'route' : 'component'
    const dts = generateDts(source, { kind })
    if (dts !== null) {
      // Mirror the source path under .stator/types: templates/x.stator →
      // .stator/types/templates/x.stator.d.ts.
      const target = join(outDir, `${rel}.d.ts`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, dts)
      written++
    }

    // Same mirroring for the virtual TSX. Relative imports inside it resolve
    // through the app's `rootDirs`; ambient Stator/JSX scaffolding is
    // self-contained per file (see compiler/virtual-code.ts).
    const virtual = toVirtualCode(source)
    const checkTarget = join(checkDir, `${rel}.check.tsx`)
    await mkdir(dirname(checkTarget), { recursive: true })
    await writeFile(checkTarget, tsxCompatible(virtual.tsx.code))
    checks++
  }
  return { written, checks, outDir }
}

/**
 * Make the embedded template region parse as TSX — applied ONLY to the
 * emitted check files (never the editor's virtual code, whose offset
 * mappings must stay 1:1 with the source). HTML-vs-TSX gaps handled:
 *   - HTML comments (stripped — not JSX),
 *   - `is:inline` scripts (body blanked — raw JS can't parse as JSX children
 *     and typechecking it as TSX would be meaningless),
 *   - void elements (self-closed — HTML allows `<input>`, TSX doesn't).
 * A regex can't do this safely: attribute expressions carry `>`/braces/quotes
 * (`checked={(t) => t.done}`), so the transform walks the template region
 * with brace- and quote-awareness and only rewrites at markup level.
 * Proper modeling in the language server is the eventual home (see the
 * Phase 2 note in compiler/virtual-code.ts).
 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])

function tsxCompatible(tsx: string): string {
  // Only server components embed the template; it is the final return block.
  const open = tsx.lastIndexOf('return (<>')
  const close = tsx.lastIndexOf('</>);')
  if (open === -1 || close === -1 || close < open) return tsx
  const head = tsx.slice(0, open)
  const tpl = tsx.slice(open, close)
  const tail = tsx.slice(close)
  return head + transformTemplate(tpl) + tail
}

function transformTemplate(tpl: string): string {
  let out = ''
  let i = 0
  while (i < tpl.length) {
    // HTML comment → drop.
    if (tpl.startsWith('<!--', i)) {
      const end = tpl.indexOf('-->', i)
      i = end === -1 ? tpl.length : end + 3
      continue
    }
    // Inline <script>: blank the body (bare client scripts were extracted by
    // splitStator; whatever remains is is:inline-style raw JS).
    if (/^<script\b/i.test(tpl.slice(i))) {
      const end = tpl.toLowerCase().indexOf('</script>', i)
      out += '<script />'
      i = end === -1 ? tpl.length : end + '</script>'.length
      continue
    }
    // Expression: copy verbatim, tracking nesting + strings.
    if (tpl[i] === '{') {
      const end = expressionEnd(tpl, i)
      out += tpl.slice(i, end)
      i = end
      continue
    }
    // Tag: scan to its real `>` (attribute quotes/expressions may contain
    // `>`), self-closing void tags that aren't already closed.
    if (tpl[i] === '<' && /[a-zA-Z]/.test(tpl[i + 1] ?? '')) {
      const tag = /^[a-zA-Z][\w-]*/.exec(tpl.slice(i + 1))![0]
      let j = i + 1 + tag.length
      while (j < tpl.length) {
        const ch = tpl[j]!
        if (ch === '"' || ch === "'") {
          const q = tpl.indexOf(ch, j + 1)
          j = q === -1 ? tpl.length : q + 1
          continue
        }
        if (ch === '{') {
          j = expressionEnd(tpl, j)
          continue
        }
        if (ch === '>') break
        j++
      }
      let piece = tpl.slice(i, j) // tag text without the final `>`
      if (VOID_TAGS.has(tag.toLowerCase()) && !piece.trimEnd().endsWith('/')) {
        piece = `${piece.trimEnd()} /`
      }
      out += `${piece}>`
      i = j + 1
      continue
    }
    out += tpl[i]
    i++
  }
  return out
}

/** Index just past the `}` closing the expression opened at `start` (which
 *  must point at `{`), respecting nested braces and string/template literals. */
function expressionEnd(tpl: string, start: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < tpl.length; i++) {
    const ch = tpl[i]!
    if (quote !== null) {
      if (ch === '\\')
        i++ // skip escaped char
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return tpl.length
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else if (e.name.endsWith('.stator')) out.push(full)
  }
  return out
}
