import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileComponentFile } from '../src/build/compile-component.ts'
import { walkFiles } from '../src/build/islands.ts'
import { entryCss } from '../src/build/route-css.ts'

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
 *
 * Also aggregates `components.css`: `@statorjs/stator` publishes its
 * components through ONE barrel subpath (`./components`, not one subpath per
 * component), so a consumer's per-route resolver (`route-css.ts`) resolves a
 * reached `'@statorjs/stator/components'` import to a SINGLE `./components.css`
 * export — the CSS reachable from `index.ts` itself, walked the same way
 * `route-css.ts` walks a route (`entryCss`, rooted at this one entry instead
 * of a routes/ directory). This trades true per-component granularity for
 * simplicity: importing `Image` from this barrel currently also pulls in
 * `Picture`'s CSS if it ever has any, and vice versa. Acceptable while the
 * barrel holds a couple of components; reconsider (per-component subpath
 * exports, each with its own `.css`) if it grows a lot more.
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

  // Aggregate the barrel's own CSS — see the module doc comment for why this
  // is one combined file rather than per-component, given today's exports
  // shape. Written even when empty-to-date would make it absent, so the
  // `./components.css` export always resolves to a real (if empty) file
  // rather than consumers' resolution succeeding or failing depending on
  // which components happen to have styles this release.
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
