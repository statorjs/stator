// A small TypeScript tokenizer for the page's code samples. The page renders
// each token as a span, so it needs no highlighting library at runtime.

export type TokenKind = 'comment' | 'string' | 'keyword' | 'number' | 'call' | 'name'
export type Token = { text: string; kind?: TokenKind }

const KEYWORDS = new Set(
  'import from export default const let var function return if else for of in new async await as type interface class extends true false null undefined'.split(
    ' ',
  ),
)

const PATTERN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g

/** Split `code` into tokens. Joining every token's text gives `code` back. */
export function highlight(code: string): Token[] {
  const tokens: Token[] = []
  const plain = (text: string): void => {
    if (text) tokens.push({ text })
  }
  let last = 0
  for (const m of code.matchAll(PATTERN)) {
    plain(code.slice(last, m.index))
    last = m.index + m[0].length
    const [text, comment, string, number, word] = m
    if (comment) tokens.push({ text, kind: 'comment' })
    else if (string) tokens.push({ text, kind: 'string' })
    else if (number) tokens.push({ text, kind: 'number' })
    else if (word && KEYWORDS.has(word)) tokens.push({ text, kind: 'keyword' })
    else if (code[last] === '(') tokens.push({ text, kind: 'call' })
    else if (/^[A-Z]/.test(text)) tokens.push({ text, kind: 'name' })
    else plain(text)
  }
  plain(code.slice(last))
  return tokens
}
