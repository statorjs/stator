/**
 * A light lexer over a `.stator` template body: finds the TOP-LEVEL
 * `<script>` / `<style>` elements and the top-level `{…}` expressions, and
 * nothing else. It replaces a pair of regexes that matched those tags
 * anywhere — inside an expression, a string or template literal, a comment —
 * so a code sample like `{'Use <script>…</script>'}` was lifted out as a
 * client component and cut the template in half.
 *
 * Three modes, as JSX has them:
 *   - markup text — quotes are literal, `{` opens an expression, `<!-- -->`
 *     is skipped, a tag is read with its attributes;
 *   - an expression — JS strings, template literals (with `${}`), comments
 *     and regex literals are skipped, and a `<` in operand position opens a
 *     nested JSX element (so `<p>Don't</p>` inside `{…}` isn't a string);
 *   - raw text — a `<script>` / `<style>` body runs verbatim to its close tag.
 *
 * It never throws: unterminated constructs run to the end and the later
 * stages (the TSX parse in `lower.ts`) report them with real positions.
 */

export interface TemplateBlock {
  tag: 'script' | 'style'
  /** Offset of the opening `<`. */
  start: number
  /** Text between the tag name and the closing `>` of the opening tag. */
  attrs: string
  contentStart: number
  contentEnd: number
  /** Offset just past the closing tag. */
  end: number
}

export interface TemplateScan {
  /** Top-level `<script>` / `<style>` elements, in source order. */
  blocks: TemplateBlock[]
  /** Inner text span of each outermost `{…}` expression — in text or in a
   *  top-level tag's attributes. Nested ones sit inside these. */
  expressions: { start: number; end: number }[]
}

const NAME_START = /[A-Za-z]/
const IDENT = /[\w$]/
const WS = /\s/
const VOID = new Set([
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
/** Keywords after which `<` / `/` start an operand (JSX, regex), not an operator. */
const OPERAND_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'await',
  'instanceof',
])

interface OpenTag {
  name: string
  attrsStart: number
  attrsEnd: number
  end: number
  selfClosing: boolean
}

/** Scan `source[from, to)` — a template body — for its top-level regions. */
export function scanTemplate(source: string, from = 0, to = source.length): TemplateScan {
  const s = source
  const blocks: TemplateBlock[] = []
  const expressions: { start: number; end: number }[] = []

  const opensElement = (at: number): boolean =>
    s[at] === '<' && (NAME_START.test(s[at + 1] ?? '') || s[at + 1] === '>')

  const skipComment = (at: number): number => {
    const e = s.indexOf('-->', at + 4)
    return e === -1 || e >= to ? to : e + 3
  }

  /** The body of a raw-text element, up to its close tag; null when unclosed. */
  const closeRaw = (tag: string, at: number): { contentEnd: number; end: number } | null => {
    const re = tag === 'script' ? /<\/script\s*>/gi : /<\/style\s*>/gi
    re.lastIndex = at
    const m = re.exec(s)
    if (!m || m.index + m[0].length > to) return null
    return { contentEnd: m.index, end: m.index + m[0].length }
  }

  /** A JS string from its opening quote; ends at the quote or (unterminated) a newline. */
  const skipString = (at: number): number => {
    const q = s[at]
    let j = at + 1
    while (j < to) {
      const c = s[j]
      if (c === '\\') j += 2
      else if (c === q) return j + 1
      else if (c === '\n') return j
      else j++
    }
    return to
  }

  const skipTemplateLiteral = (at: number): number => {
    let j = at + 1
    while (j < to) {
      const c = s[j]
      if (c === '\\') j += 2
      else if (c === '`') return j + 1
      else if (c === '$' && s[j + 1] === '{') j = skipJs(j + 1)
      else j++
    }
    return to
  }

  const skipRegex = (at: number): number => {
    let j = at + 1
    let inClass = false
    while (j < to) {
      const c = s[j]
      if (c === '\\') {
        j += 2
        continue
      }
      if (c === '\n') return j
      if (inClass) {
        if (c === ']') inClass = false
      } else if (c === '[') {
        inClass = true
      } else if (c === '/') {
        j++
        while (j < to && IDENT.test(s[j] ?? '')) j++
        return j
      }
      j++
    }
    return to
  }

  /** A JS expression from its `{`; returns the offset just past the matching `}`. */
  function skipJs(at: number): number {
    let depth = 0
    // Whether the last significant token ends an operand — decides whether a
    // following `<` / `/` is an operator or opens JSX / a regex literal.
    let afterOperand = false
    let j = at
    while (j < to) {
      const c = s[j] as string
      if (WS.test(c)) {
        j++
      } else if (c === '"' || c === "'") {
        j = skipString(j)
        afterOperand = true
      } else if (c === '`') {
        j = skipTemplateLiteral(j)
        afterOperand = true
      } else if (c === '/' && s[j + 1] === '/') {
        const e = s.indexOf('\n', j)
        j = e === -1 || e >= to ? to : e
      } else if (c === '/' && s[j + 1] === '*') {
        const e = s.indexOf('*/', j + 2)
        j = e === -1 || e >= to ? to : e + 2
      } else if (c === '/' && !afterOperand) {
        j = skipRegex(j)
        afterOperand = true
      } else if (!afterOperand && opensElement(j)) {
        j = skipElement(j)
        afterOperand = true
      } else if (IDENT.test(c)) {
        const k = j
        while (j < to && IDENT.test(s[j] ?? '')) j++
        afterOperand = !OPERAND_KEYWORDS.has(s.slice(k, j))
      } else {
        if (c === '{') depth++
        else if (c === '}' && --depth === 0) return j + 1
        afterOperand = c === ')' || c === ']' || c === '}'
        j++
      }
    }
    return to
  }

  /** An opening tag from its `<`, attributes and all. `onExpr` sees each
   *  attribute expression's span. */
  function readOpenTag(at: number, onExpr?: (start: number, end: number) => void): OpenTag {
    let j = at + 1
    while (j < to && !/[\s/>{]/.test(s[j] ?? '')) j++
    const name = s.slice(at + 1, j).toLowerCase()
    const attrsStart = j
    while (j < to) {
      const c = s[j]
      if (c === '"' || c === "'") {
        // Attribute values may span lines, unlike JS strings.
        const e = s.indexOf(c, j + 1)
        j = e === -1 || e >= to ? to : e + 1
      } else if (c === '{') {
        const e = skipJs(j)
        onExpr?.(j, e)
        j = e
      } else if (c === '/' && s[j + 1] === '>') {
        return { name, attrsStart, attrsEnd: j, end: j + 2, selfClosing: true }
      } else if (c === '>') {
        return { name, attrsStart, attrsEnd: j, end: j + 1, selfClosing: false }
      } else {
        j++
      }
    }
    return { name, attrsStart, attrsEnd: to, end: to, selfClosing: true }
  }

  /** A JSX element inside an expression, children and all. */
  function skipElement(at: number): number {
    const open = readOpenTag(at)
    if (open.selfClosing || VOID.has(open.name)) return open.end
    if (open.name === 'script' || open.name === 'style') {
      return closeRaw(open.name, open.end)?.end ?? open.end
    }
    let j = open.end
    while (j < to) {
      if (s[j] === '{') {
        j = skipJs(j)
      } else if (s.startsWith('<!--', j)) {
        j = skipComment(j)
      } else if (s[j] === '<' && s[j + 1] === '/') {
        const e = s.indexOf('>', j)
        return e === -1 || e >= to ? to : e + 1
      } else if (opensElement(j)) {
        j = skipElement(j)
      } else {
        j++
      }
    }
    return to
  }

  const recordExpr = (start: number, end: number): void => {
    expressions.push({ start: start + 1, end: s[end - 1] === '}' ? end - 1 : end })
  }

  let i = from
  while (i < to) {
    if (s[i] === '{') {
      const e = skipJs(i)
      recordExpr(i, e)
      i = e
    } else if (s.startsWith('<!--', i)) {
      i = skipComment(i)
    } else if (s[i] === '<' && NAME_START.test(s[i + 1] ?? '')) {
      const open = readOpenTag(i, recordExpr)
      const tag = open.name === 'script' || open.name === 'style' ? open.name : null
      const close = tag && !open.selfClosing ? closeRaw(tag, open.end) : null
      if (tag && close) {
        blocks.push({
          tag,
          start: i,
          attrs: s.slice(open.attrsStart, open.attrsEnd),
          contentStart: open.end,
          contentEnd: close.contentEnd,
          end: close.end,
        })
        i = close.end
      } else {
        i = open.end
      }
    } else {
      i++
    }
  }
  return { blocks, expressions }
}
