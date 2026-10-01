import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileComponentFile } from '../src/build/compile-component.ts'
import { walkFiles } from '../src/build/islands.ts'

/**
 * Publish-time compile for this package's OWN `.stator` components
 * (`src/components/*.stator`) — for this purpose, `@statorjs/stator` is a
 * `.stator` component library like any other it ships. The published package
 * must carry already-compiled `.ts` (+ a sibling `.css`, once any component
 * here has scoped styles), never raw `.stator` source: a consuming app's
 * production build never traces into `node_modules` to compile anything
 * (`toolchain-adapter-seam-and-the-vite-exit` — the boundary is load-bearing
 * for correctness, not an oversight), including this package's own
 * components. See spec
 * `stator-component-libraries-publish-time-compile-per-component-scoped-css-usage-driven-aggregation`.
 *
 * `src/components/index.ts` imports the compiled sibling directly
 * (`./image.stator.ts`, never `./image.stator`), so the package never depends
 * on a `.stator` loader being registered at runtime — this script's only job
 * is keeping that sibling fresh. The compiled `.ts` output is committed (it's
 * what `index.ts` imports, in dev and in CI alike, same as any other source
 * file) — run `pnpm build:components` after editing `image.stator` or
 * `picture.stator` and commit the result. Also wired into `prepublishOnly` so
 * a release can never ship stale compiled output even if that was missed.
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

  // Rewrite `.stator` import specifiers (component-to-component references,
  // e.g. picture.stator's `import Image from './image.stator'`) to the
  // compiled sibling — same rewrite `build.ts` does for an app's own tree.
  // Scoped to just-compiled output, never a hand-authored file like
  // `index.ts` (which already names `.stator.ts` directly).
  for (const file of compiledTsFiles) {
    const code = await readFile(file, 'utf8')
    const rewritten = code.replace(/(['"])([^'"]+\.stator)\1/g, '$1$2.ts$1')
    if (rewritten !== code) await writeFile(file, rewritten)
  }

  console.log(`stator: compiled ${files.length} component(s) under src/components/`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
