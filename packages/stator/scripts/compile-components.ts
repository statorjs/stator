import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileComponentFile } from '../src/build/compile-component.ts'
import { walkFiles } from '../src/build/islands.ts'
import { entryCss } from '../src/build/route-css.ts'

/**
 * Compiles `src/components/*.stator` to their `.ts`(+`.css`) siblings and
 * aggregates `components.css` for the `./components` barrel export. Run via
 * `pnpm build:components` after editing `image.stator`/`picture.stator` and
 * commit the result (also wired into `prepublishOnly`). See spec
 * `stator-component-libraries-publish-time-compile-per-component-scoped-css-usage-driven-aggregation`.
 */
async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = resolve(here, '..')
  const srcDir = join(root, 'src')
  const componentsDir = join(srcDir, 'components')

  const files = await walkFiles(componentsDir, (f) => f.endsWith('.stator'))
  const compiledTsFiles: string[] = []
  for (const file of files) {
    await compileComponentFile(file, srcDir)
    compiledTsFiles.push(`${file}.ts`)
  }

  // Component-to-component `.stator` imports (e.g. picture.stator importing
  // image.stator) need the same `.ts` rewrite applied to the compiled output.
  for (const file of compiledTsFiles) {
    const code = await readFile(file, 'utf8')
    const rewritten = code.replace(/(['"])([^'"]+\.stator)\1/g, '$1$2.ts$1')
    if (rewritten !== code) await writeFile(file, rewritten)
  }

  // Always written, even empty, so `./components.css` resolves consistently.
  const cssOutFile = join(componentsDir, 'components.css')
  const css = await entryCss(join(componentsDir, 'index.ts'), srcDir)
  await writeFile(cssOutFile, css)

  console.log(
    `stator: compiled ${files.length} component(s) under src/components/` +
      (css ? ` — components.css: ${css.length} bytes` : ' — components.css: empty'),
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
