/** Format an entry's timestamp for display, e.g. "Aug 2 · 14:07". Extracted
 *  here (out of the route frontmatter) so the Entry component can import it and
 *  it's unit-testable. */
export function fmtWhen(t: number): string {
  const d = new Date(t)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.toLocaleDateString('en', { month: 'short', day: 'numeric' })} · ${hh}:${mm}`
}
