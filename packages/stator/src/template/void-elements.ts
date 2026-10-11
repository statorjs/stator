/** HTML void elements: no content, no closing tag, and a trailing `/` is
 *  meaningless. Every other element must be explicitly closed — browsers
 *  parse `<div />` as an open tag. `param` is obsolete but still void. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
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
  'param',
  'source',
  'track',
  'wbr',
])

export function isVoidElement(tag: string): boolean {
  return VOID_ELEMENTS.has(tag.toLowerCase())
}
