/**
 * Compiler diagnostics: a located `CompileError` plus helpers to turn a
 * character offset in the original `.stator` source into a line/column + code
 * frame. Every compiler stage throws `CompileError`; the Vite plugin maps its
 * `loc` to Vite's error shape so the dev overlay and terminal show
 * file:line:column with a snippet.
 */

export interface DiagnosticLocation {
  file?: string
  /** 1-based line in the original `.stator` source. */
  line: number
  /** 1-based column. */
  column: number
  /** Rendered code-frame snippet (a few lines around the caret). */
  frame: string
}

export class CompileError extends Error {
  readonly loc?: DiagnosticLocation
  constructor(message: string, loc?: DiagnosticLocation) {
    super(message)
    this.name = 'CompileError'
    this.loc = loc
  }
}

/** 1-based line/column for a character offset in `source`. */
export function offsetToLineCol(source: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, source.length))
  let line = 1
  let lastNewline = -1
  for (let i = 0; i < clamped; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++
      lastNewline = i
    }
  }
  return { line, column: clamped - lastNewline }
}

/** A code frame: the offending line with a caret under the column, plus one
 *  line of context on each side. */
export function codeFrame(source: string, line: number, column: number): string {
  const lines = source.split('\n')
  const start = Math.max(1, line - 1)
  const end = Math.min(lines.length, line + 1)
  const gutterWidth = String(end).length
  const out: string[] = []
  for (let n = start; n <= end; n++) {
    const gutter = String(n).padStart(gutterWidth)
    const marker = n === line ? '>' : ' '
    out.push(`${marker} ${gutter} | ${lines[n - 1] ?? ''}`)
    if (n === line) {
      out.push(`  ${' '.repeat(gutterWidth)} | ${' '.repeat(Math.max(0, column - 1))}^`)
    }
  }
  return out.join('\n')
}

/** Build a `DiagnosticLocation` from a character offset in the original source. */
export function locAt(source: string, offset: number, file?: string): DiagnosticLocation {
  const { line, column } = offsetToLineCol(source, offset)
  return { file, line, column, frame: codeFrame(source, line, column) }
}
