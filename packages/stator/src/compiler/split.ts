/**
 * Stage 1 of the `.stator` compiler: split a source file into its regions.
 *
 * A `.stator` file has up to four regions:
 *   - `---` frontmatter fence (server: type-only machine imports, props)
 *   - the JSX-flavored template body (server-rendered)
 *   - one or more `<style>` blocks (scoped styles)
 *   - one or more bare `<script>` blocks (client code)
 *
 * Region detection is a light lexer (`template-scan.ts`), not a parse — the
 * JSX *inside* the template is handed to the TypeScript parser by `lower.ts`. Only TOP-LEVEL `<script>` / `<style>` elements are regions: the same
 * text inside a `{…}` expression, a string or a comment is template content.
 * Splitting is the only job of this module.
 *
 * Script disambiguation: an **inline** `<script>` is the component's client
 * code — it's pulled out as a region and compiled to a `StatorElement`. Two explicit forms opt out and stay in the template as
 * literal document markup, emitted verbatim:
 *   - `<script src="...">`  — an external reference is never an inline component.
 *   - `<script is:inline>`  — opt-out directive for a verbatim inline script.
 * Note the rule keys off *presence* of `src` / `is:inline`, not "has any
 * attribute": `<script type="module">` or `<script lang="ts">` are still
 * compiled as components, so an incidental attribute can't silently demote a
 * component to dead markup. (`<style>` keys off the bare-vs-attributed rule
 * instead.)
 */

import { scanTemplate, type TemplateBlock } from './template-scan.ts'

export interface ParsedStator {
  /** TS/JS between the `---` fences. Empty string when there's no fence. */
  frontmatter: string
  /** Character offset in the original source where `frontmatter` (trimmed)
   *  begins — maps frontmatter positions back to the source. */
  frontmatterOffset: number
  /** The template body with `<style>` and bare `<script>` regions removed. */
  template: string
  /** Contents of each bare `<style>` region, in source order. */
  styles: string[]
  /** Contents of each inline `<script>` region (client code), in source order. */
  scripts: string[]
  /** Character offset in the original source of each captured `<script>` region's
   *  opening tag, parallel to `scripts` — used to locate diagnostics. */
  scriptOffsets: number[]
  /** Character offset in the original source where each `scripts` entry (its
   *  trimmed content) begins, parallel to `scripts` — for source maps. */
  scriptContentOffsets: number[]
  /** Character offset in the original source where the (trimmed) template body
   *  begins — used to map template diagnostics back to original positions.
   *  Assumes `<style>`/`<script>` regions follow the template body (the
   *  convention), so leading offset is unaffected by their removal. */
  templateOffset: number
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/

/** True if `attrs` (the text between `<script` and `>`) carries `name` as a
 *  whole attribute token — so `src` matches `src="x"` but not `data-src`. */
function hasAttr(attrs: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)${escaped}(?=[\\s=/]|$)`, 'i').test(attrs)
}

/** Whether a top-level block is a region: a `<script>` without `src` /
 *  `is:inline`, or a bare `<style>`. The rest stay in the template as markup. */
function isRegion(block: TemplateBlock): boolean {
  if (block.tag === 'style') return block.attrs.trim() === ''
  return !hasAttr(block.attrs, 'src') && !hasAttr(block.attrs, 'is:inline')
}

export function splitStator(source: string): ParsedStator {
  let rest = source
  let frontmatter = ''
  let frontmatterLen = 0
  let frontmatterOffset = 0

  const fm = rest.match(FRONTMATTER_RE)
  if (fm) {
    const raw = fm[1] ?? ''
    frontmatter = raw.trim()
    frontmatterOffset = fm[0].indexOf('\n') + 1 + (raw.length - raw.trimStart().length)
    frontmatterLen = fm[0].length
    rest = rest.slice(frontmatterLen)
  }

  // Leading whitespace before the template body (after the frontmatter).
  const leadingWs = rest.length - rest.trimStart().length
  const templateOffset = frontmatterLen + leadingWs

  const scripts: string[] = []
  const scriptOffsets: number[] = []
  const scriptContentOffsets: number[] = []
  const styles: string[] = []
  let template = ''
  let last = 0
  for (const block of scanTemplate(rest).blocks) {
    if (!isRegion(block)) continue
    const raw = rest.slice(block.contentStart, block.contentEnd)
    const content = raw.trim()
    if (block.tag === 'script') {
      scripts.push(content)
      scriptOffsets.push(frontmatterLen + block.start)
      scriptContentOffsets.push(
        frontmatterLen + block.contentStart + (raw.length - raw.trimStart().length),
      )
    } else {
      styles.push(content)
    }
    template += rest.slice(last, block.start)
    last = block.end
  }
  template += rest.slice(last)

  return {
    frontmatter,
    frontmatterOffset,
    template: template.trim(),
    styles,
    scripts,
    scriptOffsets,
    scriptContentOffsets,
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
 * emit. Shares this module's scanner + classification so the LS and the
 * runtime compiler never disagree about what's a region.
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
  const scripts: SourceRegion[] = []
  for (const block of scanTemplate(source, bodyStart).blocks) {
    if (!isRegion(block)) continue
    const region = {
      contentOffset: block.contentStart,
      content: source.slice(block.contentStart, block.contentEnd),
    }
    ;(block.tag === 'script' ? scripts : styles).push(region)
    if (block.start < firstBlock) firstBlock = block.start
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
