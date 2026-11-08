import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { walkFiles } from './islands.ts'
import { moduleLabel, type Reach, reachFrom } from './reachability.ts'

/**
 * Per-route scoped CSS (spec
 * `stator-component-libraries-publish-time-compile-per-component-scoped-css-usage-driven-aggregation`,
 * revised by `library-islands-…` for 3.0). Each route's sheet is the sibling
 * `.css` of every module its import graph reaches (`reachability.ts`), app or
 * package alike, read by path: a package module's CSS is its own sibling, not
 * whatever the package's `exports` map hands out for `${specifier}.css`.
 */

/** Where a route's stylesheet is served, under `/static/`: the route's path
 *  relative to the app root, compiled extension dropped, `.css` added. A build
 *  (`routes/index.stator.ts`) and dev (`routes/index.stator`) name the same
 *  route the same way: `css/routes/index.stator.css`. */
export function routeCssPath(routeRel: string): string {
  return `css/${routeRel.replace(/\\/g, '/').replace(/\.(ts|js)$/, '')}.css`
}

/** A reached module's CSS, ahead of its sibling file: dev hands in its
 *  in-memory compile of the app's `.stator` files. Undefined falls back to the
 *  sibling. */
export type CssLookup = (file: string) => string | undefined | Promise<string | undefined>

/** A module's sibling CSS — `foo.ts` → `foo.css`. Most modules have none;
 *  that's a silent, expected miss. */
async function siblingCss(file: string): Promise<string | undefined> {
  const cssPath = file.replace(/\.(ts|js)$/, '.css')
  if (cssPath === file) return undefined
  try {
    return await readFile(cssPath, 'utf8')
  } catch {
    return undefined
  }
}

/** One sheet from everything a walk reached. App modules first, then
 *  packages, each in label order: dev and build walk different absolute paths
 *  (the app versus `dist/`), so ordering by path would not give one sheet. */
async function cssOf(reach: Reach, appRoot: string, cssFor?: CssLookup): Promise<string> {
  const mods = [...reach.modules.values()]
    .map((mod) => ({ mod, label: moduleLabel(mod, appRoot) }))
    .sort((a, b) => Number(!!a.mod.pkg) - Number(!!b.mod.pkg) || (a.label < b.label ? -1 : 1))
  let css = ''
  for (const { mod, label } of mods) {
    const text = (await cssFor?.(mod.file)) ?? (await siblingCss(mod.file))
    if (text) css += `/* ${label} */\n${text}\n`
  }
  return css
}

/**
 * Walk each route file's import graph and collect the CSS of every reached
 * module. Returns absolute route file → one stylesheet, only for routes that
 * reached any CSS at all.
 */
export async function routeCssMap(opts: {
  routesDir: string
  baseDir: string
  cssFor?: CssLookup
}): Promise<Map<string, string>> {
  const baseDir = resolve(opts.baseDir)
  const routeFiles = await walkFiles(opts.routesDir, (f) => /\.(ts|js|stator)$/.test(f)).catch(
    () => [] as string[],
  )
  const out = new Map<string, string>()
  for (const routeFile of routeFiles) {
    const reach = await reachFrom(routeFile, { appRoot: baseDir })
    const css = await cssOf(reach, baseDir, opts.cssFor)
    if (css) out.set(routeFile, css)
  }
  return out
}

/** The same collection from a single entry inside one package, stopping at
 *  bare specifiers — a component library's own aggregate `components.css`. */
export async function entryCss(entryFile: string, baseDir: string): Promise<string> {
  const reach = await reachFrom(entryFile, { appRoot: baseDir, packages: false })
  return cssOf(reach, resolve(baseDir))
}
