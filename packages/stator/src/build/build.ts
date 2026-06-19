import { cp, readdir, readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { compile } from '../compiler/index.ts'

/**
 * Production build: compile a `.stator` app to a `dist/` of plain `.ts` that the
 * existing `createApp` + tsx runtime serves with no Vite.
 *
 *   1. copy machines / routes / templates / static into dist
 *   2. compile each `*.stator` → a sibling `*.stator.ts`, delete the `.stator`,
 *      accumulate scoped CSS
 *   3. rewrite `.stator` import specifiers (`'./x.stator'` → `'./x.stator.ts'`)
 *   4. write the concatenated scoped CSS to `dist/static/components.css`
 *
 * The prod server runs `createApp` over `dist/` with a `headExtras` hook that
 * links `components.css`. File discovery + dynamic import work unchanged on the
 * precompiled output — no bundler, no loader hooks.
 */

export interface BuildConfig {
  /** App directory containing machines/ routes/ templates/ static/. */
  root: string
  /** Output directory. Wiped and recreated. */
  outDir: string
  /** Subdirectories to copy into dist. Defaults to the four conventional dirs. */
  dirs?: string[]
}

export interface BuildResult {
  outDir: string
  /** Number of `.stator` files compiled. */
  compiled: number
  /** True when any component produced scoped CSS (components.css written). */
  hasCss: boolean
}

export async function buildApp(config: BuildConfig): Promise<BuildResult> {
  const root = resolve(config.root)
  const outDir = resolve(config.outDir)
  const dirs = config.dirs ?? ['machines', 'routes', 'templates', 'static']

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  for (const d of dirs) {
    const src = join(root, d)
    if (await exists(src)) await cp(src, join(outDir, d), { recursive: true })
  }

  // Compile every .stator into a sibling .stator.ts; collect CSS.
  const statorFiles = await walk(outDir, (f) => f.endsWith('.stator'))
  let css = ''
  for (const file of statorFiles) {
    const source = await readFile(file, 'utf8')
    const result = compile(source, { id: relative(outDir, file) })
    await writeFile(file + '.ts', result.serverCode)
    await rm(file)
    if (result.css) css += `/* ${relative(outDir, file)} */\n${result.css}\n`
  }

  // Rewrite `.stator` import specifiers to the compiled `.stator.ts` sibling.
  const tsFiles = await walk(outDir, (f) => f.endsWith('.ts'))
  for (const file of tsFiles) {
    const code = await readFile(file, 'utf8')
    const rewritten = code.replace(/(['"])([^'"]+\.stator)\1/g, '$1$2.ts$1')
    if (rewritten !== code) await writeFile(file, rewritten)
  }

  if (css) {
    await mkdir(join(outDir, 'static'), { recursive: true })
    await writeFile(join(outDir, 'static', 'components.css'), css)
  }

  return { outDir, compiled: statorFiles.length, hasCss: Boolean(css) }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function walk(dir: string, match: (file: string) => boolean): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full, match)))
    else if (match(full)) out.push(full)
  }
  return out
}
