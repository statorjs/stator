/**
 * Stage 1 of the `.stator` compiler: split a source file into its regions.
 *
 * A `.stator` file has up to four regions:
 *   - `---` frontmatter fence (server: type-only machine imports, props)
 *   - the JSX-flavored template body (server-rendered)
 *   - one or more `<style>` blocks (scoped styles)
 *   - one or more bare `<script>` blocks (client code; processed in 3b)
 *
 * Region detection is intentionally string-level here — the JSX *inside* the
 * template is handed to the TypeScript parser in a later stage. Splitting is the
 * only job of this module.
 *
 * Disambiguation rule: a component region is a **bare, attribute-less**
 * `<style>` / `<script>`. A tag with attributes (`<script src="...">`,
 * `<style media="print">`) is literal document markup and is left in the
 * template. This is what lets a server template emit a real
 * `<script src="/static/client.js"></script>` without it being mistaken for a
 * client-code region.
 */

export interface ParsedStator {
  /** TS/JS between the `---` fences. Empty string when there's no fence. */
  frontmatter: string
  /** The template body with `<style>` and bare `<script>` regions removed. */
  template: string
  /** Contents of each bare `<style>` region, in source order. */
  styles: string[]
  /** Contents of each bare `<script>` region (client code), in source order. */
  scripts: string[]
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/
const STYLE_RE = /<style>([\s\S]*?)<\/style>/g
const SCRIPT_RE = /<script>([\s\S]*?)<\/script>/g

export function splitStator(source: string): ParsedStator {
  let rest = source
  let frontmatter = ''

  const fm = rest.match(FRONTMATTER_RE)
  if (fm) {
    frontmatter = (fm[1] ?? '').trim()
    rest = rest.slice(fm[0].length)
  }

  const styles: string[] = []
  rest = rest.replace(STYLE_RE, (_m, css: string) => {
    styles.push(css.trim())
    return ''
  })

  const scripts: string[] = []
  rest = rest.replace(SCRIPT_RE, (_m, js: string) => {
    scripts.push(js.trim())
    return ''
  })

  return { frontmatter, template: rest.trim(), styles, scripts }
}
