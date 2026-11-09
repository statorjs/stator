/**
 * Source maps for compiled `.stator` modules.
 *
 * The compiler builds its output by string concatenation, so instead of
 * threading positions through every emitter it drops a MARK — a private-use
 * code point pair around an original-source offset — at each place it copies
 * source text: every frontmatter statement (and every line inside one), every
 * template expression and component call. `finalizeSourceMap` then walks the
 * finished module once, strips the marks, and records where each one landed:
 * that is the map. Code the compiler invents (the `defineRoute` wrapper, the
 * template literal's markup) carries no mark and maps to nothing.
 *
 * Marking is skipped for a source that itself contains the marker code points,
 * so a mark can never be confused with author text.
 */

const OPEN = ''
const CLOSE = ''
const MARKS = /\d+/g

export interface SourceMapV3 {
  version: 3
  sources: string[]
  sourcesContent: string[]
  names: string[]
  mappings: string
}

/** A mark recording that the text after it starts at `offset` in the source. */
export const mark = (offset: number): string => `${OPEN}${offset}${CLOSE}`

/** Whether `source` can be marked (it contains no marker code point itself). */
export const canMark = (source: string): boolean =>
  !source.includes(OPEN) && !source.includes(CLOSE)

export const stripMarks = (code: string): string => code.replace(MARKS, '')

/** `text`, copied verbatim from `start` in the source, with a mark at its start
 *  and at the first token of each later line, so every line maps to its own
 *  source line and a line's leading token to its own column. */
export function markVerbatim(text: string, start: number): string {
  let out = mark(start)
  let from = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    let tok = i + 1
    while (tok < text.length && (text[tok] === ' ' || text[tok] === '\t')) tok++
    out += text.slice(from, tok) + mark(start + tok)
    from = tok
  }
  return out + text.slice(from)
}

/**
 * Apply `repls` (non-overlapping `[start, end, replacement]`, positions in the
 * same coordinates as `textStart`) to `text`. With `toSource`, the verbatim
 * runs are marked line by line and each replacement is marked at the source
 * position it replaces.
 */
export function splice(
  text: string,
  textStart: number,
  repls: ReadonlyArray<readonly [start: number, end: number, replacement: string]>,
  toSource?: (pos: number) => number,
): string {
  const sorted = [...repls].sort((a, b) => a[0] - b[0])
  let out = ''
  let at = textStart
  const verbatim = (end: number): string => {
    const run = text.slice(at - textStart, end - textStart)
    return toSource && run ? markVerbatim(run, toSource(at)) : run
  }
  for (const [start, end, replacement] of sorted) {
    out += verbatim(start)
    out += toSource ? mark(toSource(start)) + replacement : replacement
    at = end
  }
  return out + verbatim(textStart + text.length)
}

/** Strip the marks from `code` and build the map they describe. */
export function finalizeSourceMap(
  code: string,
  source: string,
  sourceName: string,
): { code: string; map: SourceMapV3 } {
  const lineStarts = [0]
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) {
    lineStarts.push(i + 1)
  }
  const sourcePos = (offset: number): [line: number, col: number] => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return [lo, offset - lineStarts[lo]!]
  }

  const lines: Array<Array<[genCol: number, line: number, col: number]>> = [[]]
  let out = ''
  let col = 0
  const advance = (text: string): void => {
    out += text
    const nl = text.lastIndexOf('\n')
    if (nl === -1) {
      col += text.length
      return
    }
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines.push([])
    col = text.length - nl - 1
  }
  let from = 0
  for (let i = code.indexOf(OPEN); i !== -1; i = code.indexOf(OPEN, from)) {
    const close = code.indexOf(CLOSE, i)
    advance(code.slice(from, i))
    const [line, srcCol] = sourcePos(Number(code.slice(i + 1, close)))
    const segs = lines[lines.length - 1]!
    // Two marks at one column (a replacement opening a verbatim run): the later
    // one is the more specific.
    if (segs.length > 0 && segs[segs.length - 1]![0] === col) segs.pop()
    segs.push([col, line, srcCol])
    from = close + 1
  }
  advance(code.slice(from))

  let prevLine = 0
  let prevCol = 0
  const mappings = lines
    .map((segs) => {
      let prevGen = 0
      return segs
        .map(([gen, line, srcCol]) => {
          const s = vlq(gen - prevGen) + vlq(0) + vlq(line - prevLine) + vlq(srcCol - prevCol)
          prevGen = gen
          prevLine = line
          prevCol = srcCol
          return s
        })
        .join(',')
    })
    .join(';')

  return {
    code: out,
    map: { version: 3, sources: [sourceName], sourcesContent: [source], names: [], mappings },
  }
}

/** The `//# sourceMappingURL=` comment carrying `map` inline. */
export function inlineSourceMapComment(map: SourceMapV3): string {
  const bytes = new TextEncoder().encode(JSON.stringify(map))
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `//# sourceMappingURL=data:application/json;base64,${btoa(binary)}`
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function vlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1
  let s = ''
  do {
    let digit = v & 31
    v >>>= 5
    if (v > 0) digit |= 32
    s += B64[digit]
  } while (v > 0)
  return s
}

/** A decoded map: per generated line, its segments as
 *  `[genCol, sourceLine, sourceCol]`, ascending by `genCol`, zero-based. */
export function decodeMappings(mappings: string): Array<Array<[number, number, number]>> {
  let line = 0
  let col = 0
  return mappings.split(';').map((group) => {
    let gen = 0
    const segs: Array<[number, number, number]> = []
    for (const seg of group.split(',')) {
      if (!seg) continue
      const [dGen = 0, , dLine = 0, dCol = 0] = unvlq(seg)
      gen += dGen
      line += dLine
      col += dCol
      segs.push([gen, line, col])
    }
    return segs
  })
}

function unvlq(seg: string): number[] {
  const out: number[] = []
  let v = 0
  let shift = 0
  for (const ch of seg) {
    const digit = B64.indexOf(ch)
    v += (digit & 31) << shift
    if (digit & 32) {
      shift += 5
      continue
    }
    out.push(v & 1 ? -(v >>> 1) : v >>> 1)
    v = 0
    shift = 0
  }
  return out
}
