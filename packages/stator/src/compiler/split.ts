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
 * Script disambiguation: an **inline** `<script>` is the component's client
 * code — it's pulled out as a region and (in a later stage) compiled to a
 * `StatorElement`. Two explicit forms opt out and stay in the template as
 * literal document markup, emitted verbatim:
 *   - `<script src="...">`  — an external reference is never an inline component.
 *   - `<script is:inline>`  — opt-out directive for a verbatim inline script.
 * Note the rule keys off *presence* of `src` / `is:inline`, not "has any
 * attribute": `<script type="module">` or `<script lang="ts">` are still
 * compiled as components, so an incidental attribute can't silently demote a
 * component to dead markup. (`<style>` still uses the older bare-vs-attributed
 * rule; aligning it on `is:inline` is a follow-up.)
 */

export interface ParsedStator {
  /** TS/JS between the `---` fences. Empty string when there's no fence. */
  frontmatter: string
  /** The template body with `<style>` and bare `<script>` regions removed. */
  template: string
  /** Contents of each bare `<style>` region, in source order. */
  styles: string[]
  /** Contents of each inline `<script>` region (client code), in source order. */
  scripts: string[]
  /** Character offset in the original source of each captured `<script>` region's
   *  opening tag, parallel to `scripts` — used to locate diagnostics. */
  scriptOffsets: number[]
  /** Character offset in the original source where the (trimmed) template body
   *  begins — used to map template diagnostics back to original positions.
   *  Assumes `<style>`/`<script>` regions follow the template body (the
   *  convention), so leading offset is unaffected by their removal. */
  templateOffset: number
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/
const STYLE_RE = /<style>([\s\S]*?)<\/style>/g
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/g

/** True if `attrs` (the text between `<script` and `>`) carries `name` as a
 *  whole attribute token — so `src` matches `src="x"` but not `data-src`. */
function hasAttr(attrs: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)${escaped}(?=[\\s=/]|$)`, 'i').test(attrs)
}

export function splitStator(source: string): ParsedStator {
  let rest = source
  let frontmatter = ''
  let frontmatterLen = 0

  const fm = rest.match(FRONTMATTER_RE)
  if (fm) {
    frontmatter = (fm[1] ?? '').trim()
    frontmatterLen = fm[0].length
    rest = rest.slice(frontmatterLen)
  }

  // Leading whitespace before the template body (after the frontmatter).
  const leadingWs = rest.length - rest.trimStart().length
  const templateOffset = frontmatterLen + leadingWs

  // Scripts before styles so the captured offsets are relative to the
  // post-frontmatter text (style removal hasn't shifted anything yet).
  const scripts: string[] = []
  const scriptOffsets: number[] = []
  rest = rest.replace(SCRIPT_RE, (match, attrs: string, js: string, offset: number) => {
    // `src` / `is:inline` mark a literal script — leave it in the template.
    if (hasAttr(attrs, 'src') || hasAttr(attrs, 'is:inline')) return match
    scripts.push(js.trim())
    scriptOffsets.push(frontmatterLen + offset)
    return ''
  })

  const styles: string[] = []
  rest = rest.replace(STYLE_RE, (_m, css: string) => {
    styles.push(css.trim())
    return ''
  })

  return {
    frontmatter,
    template: rest.trim(),
    styles,
    scripts,
    scriptOffsets,
    templateOffset,
  }
}

/** A region's inner text plus the absolute source offset where that text begins.
 *  Unlike `splitStator` (which trims and drops offsets), this keeps exact
 *  positions so the language-server emit can map generated code back to source. */
export interface SourceRegion {
  contentOffset: number
  content: string
}

export interface ScannedRegions {
  /** The `---` frontmatter content (server TS), or null when there's no fence. */
  frontmatter: SourceRegion | null
  /** The contiguous template body — everything from the body start up to the
   *  first trailing `<style>` / component `<script>` block. Assumes the
   *  conventional layout (template first, blocks after). */
  template: SourceRegion
  /** Each bare `<style>` block's CSS content, in source order. */
  styles: SourceRegion[]
  /** Each component (non-literal) `<script>` block's TS content, in source order.
   *  `src` / `is:inline` scripts are excluded — same classification as `splitStator`. */
  scripts: SourceRegion[]
}

/**
 * Scan a `.stator` source into regions with exact source offsets — the
 * position-preserving companion to `splitStator`, used by the language-server
 * emit. Shares this module's patterns + `hasAttr` classification so the LS and
 * the runtime compiler never disagree about what's a region.
 */
export function scanRegions(source: string): ScannedRegions {
  let bodyStart = 0
  let frontmatter: SourceRegion | null = null
  const fm = FRONTMATTER_RE.exec(source)
  if (fm) {
    const prefix = /^---[ \t]*\r?\n/.exec(fm[0])![0]
    frontmatter = { contentOffset: prefix.length, content: fm[1] ?? '' }
    bodyStart = fm[0].length
  }

  let firstBlock = source.length
  const styles: SourceRegion[] = []
  for (const m of source.matchAll(STYLE_RE)) {
    const start = m.index
    styles.push({
      contentOffset: start + '<style>'.length,
      content: m[1] ?? '',
    })
    if (start < firstBlock) firstBlock = start
  }
  const scripts: SourceRegion[] = []
  for (const m of source.matchAll(SCRIPT_RE)) {
    if (hasAttr(m[1] ?? '', 'src') || hasAttr(m[1] ?? '', 'is:inline')) continue
    const start = m.index
    const openLen = m[0].indexOf('>') + 1
    scripts.push({ contentOffset: start + openLen, content: m[2] ?? '' })
    if (start < firstBlock) firstBlock = start
  }

  const templateEnd = Math.max(bodyStart, firstBlock)
  return {
    frontmatter,
    template: {
      contentOffset: bodyStart,
      content: source.slice(bodyStart, templateEnd),
    },
    styles,
    scripts,
  }
}
